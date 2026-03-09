// Main setup wizard Ink component.
// Manages step state, renders steps sequentially, handles user input.

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useApp } from "ink";
import { TextInput, ConfirmInput } from "@inkjs/ui";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { colors } from "./lib/theme.js";
import { WelcomeScreen } from "./components/WelcomeScreen.js";
import { StepList } from "./components/StepList.js";
import {
  familiarHome,
  ensureDirs,
  configPath,
  envFilePath,
  mcpToolsPath,
  initStatePath,
} from "../lib/paths.js";
import {
  runAllChecks,
  checkGateway,
  checkOllama,
  checkClaude,
} from "../lib/prereqs.js";
import {
  getServiceDefs,
  checkServiceHealth,
} from "../lib/services.js";
import {
  generateGatewayConfig,
  generateEnvFile,
  generateMcpToolsConfig,
  generateGatewayToken,
} from "../lib/config-gen.js";
import { writeProfile, setPreference } from "../lib/profile.js";

const e = React.createElement;

// ── Lite-mode detection ─────────────────────────────────────────────────────
// When running from a standalone binary (no repo source), skip service/health
// steps and show clone instructions instead.

function detectLiteMode() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  return !existsSync(resolve(repoRoot, "services", "gateway.mjs"));
}

const LITE_MODE = detectLiteMode();

// ── Step definitions ────────────────────────────────────────────────────────

const STEP_DEFS = [
  { id: "system_check", label: "System check" },
  { id: "global_command", label: "Global command" },
  { id: "gateway", label: "Gateway" },
  { id: "ollama", label: "Ollama" },
  { id: "claude", label: "Claude Code" },
  { id: "config", label: "Configuration" },
  { id: "directories", label: "Directories" },
  { id: "mcp_bridge", label: "MCP Bridge" },
  { id: "services", label: "Services" },
  { id: "health", label: "Health check" },
  { id: "brain_bootstrap", label: "Brain setup" },
  { id: "profile", label: "Profile" },
];

// ── Init state persistence ──────────────────────────────────────────────────

function readInitState() {
  try {
    const p = initStatePath();
    if (existsSync(p)) {
      const state = JSON.parse(readFileSync(p, "utf-8"));
      // Stale state guard: if the config file is missing, the user wiped
      // ~/.familiar — ignore the saved state and start fresh.
      if (!existsSync(configPath())) {
        return { completedSteps: [], timestamp: null };
      }
      return state;
    }
  } catch { /* ignore */ }
  return { completedSteps: [], timestamp: null };
}

function writeInitState(state) {
  try {
    writeFileSync(initStatePath(), JSON.stringify(state, null, 2) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

function markStepComplete(stepId) {
  const state = readInitState();
  if (!state.completedSteps.includes(stepId)) {
    state.completedSteps.push(stepId);
  }
  state.timestamp = new Date().toISOString();
  writeInitState(state);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function tryExec(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: opts.timeout || 30000,
      stdio: ["pipe", "pipe", "pipe"],
      ...opts,
    }).trim();
  } catch {
    return null;
  }
}

function whichSync(name) {
  return tryExec(`which ${name}`);
}

// ── Prompt sub-components ───────────────────────────────────────────────────

function ConfirmPrompt({ question, onResult, defaultYes }) {
  return e(Box, { marginLeft: 2, marginTop: 1 },
    e(Text, { color: colors.cyan }, `? ${question} `),
    e(ConfirmInput, {
      defaultChoice: defaultYes !== false ? "confirm" : "deny",
      onConfirm: () => onResult(true),
      onCancel: () => onResult(false),
    })
  );
}

function TextPrompt({ question, onSubmit, placeholder, optional }) {
  return e(Box, { marginLeft: 2, marginTop: 1 },
    e(Text, { color: colors.cyan }, `? ${question}`),
    optional ? e(Text, { color: colors.grayDim }, " (optional)") : null,
    e(Text, { color: colors.cyan }, ": "),
    e(TextInput, {
      placeholder: placeholder || "",
      onSubmit: (val) => onSubmit(val || ""),
    })
  );
}

// ── Main Wizard ─────────────────────────────────────────────────────────────

export function WizardApp() {
  const app = useApp();

  // Step tracking
  const [steps, setSteps] = useState(() => {
    const saved = readInitState();
    const isResuming = saved.completedSteps.length > 0;
    return STEP_DEFS.map((def) => ({
      ...def,
      status: saved.completedSteps.includes(def.id) ? "done" : "pending",
      detail: saved.completedSteps.includes(def.id) ? "previously completed" : "",
    }));
  });

  const [resuming] = useState(() => readInitState().completedSteps.length > 0);
  const [currentStepIdx, setCurrentStepIdx] = useState(() => {
    const saved = readInitState();
    const firstIncomplete = STEP_DEFS.findIndex(
      (s) => !saved.completedSteps.includes(s.id)
    );
    return firstIncomplete === -1 ? STEP_DEFS.length : firstIncomplete;
  });

  // Phase within a step (for multi-phase steps like config)
  const [phase, setPhase] = useState("init");
  const [finished, setFinished] = useState(false);

  // Collected data across steps
  const dataRef = useRef({
    gatewayToken: generateGatewayToken(),
    anthropicKey: "",
    slackToken: "",
    telegramToken: "",
    claudeFound: false,
    ollamaFound: false,
    gatewayFound: false,
    profileName: "",
    profileRole: "",
    profileOrg: "",
  });

  // ── Step update helper ──────────────────────────────────────────────────

  const updateStep = useCallback((id, patch) => {
    setSteps((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...patch } : s))
    );
  }, []);

  const completeStep = useCallback((id, detail) => {
    updateStep(id, { status: "done", detail: detail || "" });
    markStepComplete(id);
  }, [updateStep]);

  const failStep = useCallback((id, detail) => {
    updateStep(id, { status: "failed", detail: detail || "failed" });
  }, [updateStep]);

  const skipStep = useCallback((id, detail) => {
    updateStep(id, { status: "skipped", detail: detail || "skipped" });
    markStepComplete(id);
  }, [updateStep]);

  const activateStep = useCallback((id) => {
    updateStep(id, { status: "active", detail: "" });
  }, [updateStep]);

  const advanceToNext = useCallback(() => {
    setCurrentStepIdx((prev) => prev + 1);
    setPhase("init");
  }, []);

  // ── Step execution logic ──────────────────────────────────────────────

  // Each step runs when currentStepIdx changes.
  // Some steps need user input, so they set phase states and wait.

  useEffect(() => {
    if (currentStepIdx >= STEP_DEFS.length) {
      // All done
      setFinished(true);
      return;
    }

    const stepDef = STEP_DEFS[currentStepIdx];

    // Skip already-completed steps (from resume)
    if (readInitState().completedSteps.includes(stepDef.id)) {
      advanceToNext();
      return;
    }

    // Activate the current step
    activateStep(stepDef.id);

    // Auto-run steps that need no input
    if (stepDef.id === "system_check" && phase === "init") {
      runSystemCheck();
    } else if (stepDef.id === "global_command" && phase === "init") {
      runGlobalCommand();
    } else if (stepDef.id === "gateway" && phase === "init") {
      runGatewayCheck();
    } else if (stepDef.id === "ollama" && phase === "init") {
      runOllamaCheck();
    } else if (stepDef.id === "claude" && phase === "init") {
      runClaudeCheck();
    } else if (stepDef.id === "directories" && phase === "init") {
      runDirectories();
    } else if (stepDef.id === "services" && phase === "init") {
      runServices();
    } else if (stepDef.id === "health" && phase === "init") {
      runHealthCheck();
    } else if (stepDef.id === "brain_bootstrap" && phase === "init") {
      runBrainBootstrap();
    }
    // config, mcp_bridge, profile phases are driven by user input / phase changes
  }, [currentStepIdx, phase]);

  // ── Step implementations ──────────────────────────────────────────────

  function runSystemCheck() {
    setTimeout(() => {
      const checks = runAllChecks();
      if (!checks.platform.supported) {
        failStep("system_check", `Unsupported platform: ${checks.platform.platform}`);
        return;
      }

      const parts = [];
      if (checks.platform.supported) parts.push(`macOS ${checks.platform.version}`);
      if (checks.bun.installed) parts.push(`Bun ${checks.bun.version}`);
      if (checks.brew.installed) parts.push(`Brew ${checks.brew.version}`);

      const missing = [];
      if (!checks.bun.installed) missing.push("Bun");
      if (!checks.brew.installed) missing.push("Homebrew");

      if (missing.length > 0) {
        failStep("system_check", `Missing: ${missing.join(", ")}`);
        return;
      }

      completeStep("system_check", parts.join(", "));
      advanceToNext();
    }, 300);
  }

  function runGlobalCommand() {
    setTimeout(() => {
      // Check if familiar is already on PATH
      const existing = whichSync("familiar");
      if (existing) {
        completeStep("global_command", existing);
        advanceToNext();
        return;
      }

      // Try npm link first (puts binaries in /opt/homebrew/bin/ or /usr/local/bin/)
      updateStep("global_command", { status: "active", detail: "linking via npm..." });
      const cliDir = resolve(__dirname, "..");
      const npmResult = tryExec(`npm link`, { timeout: 30000, cwd: cliDir });
      if (npmResult !== null) {
        const check = whichSync("familiar");
        if (check) {
          completeStep("global_command", check);
          advanceToNext();
          return;
        }
      }

      // Fallback: bun link (puts binaries in ~/.bun/bin/)
      const bunResult = tryExec(`bun link`, { timeout: 30000, cwd: cliDir });
      if (bunResult !== null) {
        const bunBin = resolve(process.env.HOME || "/tmp", ".bun", "bin");
        const check = whichSync("familiar");
        if (check) {
          completeStep("global_command", check);
        } else {
          // familiar is in ~/.bun/bin but not on PATH — add to shell profile
          const shell = process.env.SHELL || "/bin/zsh";
          const profileFile = shell.includes("zsh")
            ? resolve(process.env.HOME || "/tmp", ".zshrc")
            : resolve(process.env.HOME || "/tmp", ".bashrc");
          const exportLine = `export PATH="${bunBin}:$PATH"`;

          try {
            const profileContent = existsSync(profileFile) ? readFileSync(profileFile, "utf-8") : "";
            if (!profileContent.includes(".bun/bin")) {
              appendFileSync(profileFile, `\n# Added by familiar init\n${exportLine}\n`, "utf-8");
              completeStep("global_command", `added ~/.bun/bin to ${profileFile.split("/").pop()}`);
            } else {
              completeStep("global_command", `~/.bun/bin (already in ${profileFile.split("/").pop()})`);
            }
          } catch {
            completeStep("global_command", `~/.bun/bin (add to PATH manually)`);
          }
        }
      } else {
        failStep("global_command", "could not link — run npm link from cli/ manually");
      }
      advanceToNext();
    }, 300);
  }

  function runGatewayCheck() {
    setTimeout(() => {
      const result = checkGateway();
      dataRef.current.gatewayFound = result.installed;
      if (result.installed) {
        completeStep("gateway", `v${result.version}`);
        advanceToNext();
      } else {
        // Need user input
        setPhase("ask_install");
      }
    }, 200);
  }

  function handleGatewayInstall(yes) {
    if (yes) {
      updateStep("gateway", { status: "active", detail: "starting gateway..." });
      setTimeout(() => {
        const result = tryExec("launchctl kickstart gui/$(id -u)/com.familiar.gateway", { timeout: 60000 });
        if (result !== null) {
          const check = checkGateway();
          if (check.installed) {
            dataRef.current.gatewayFound = true;
            completeStep("gateway", `running v${check.version}`);
          } else {
            failStep("gateway", "started but health check failed");
          }
        } else {
          failStep("gateway", "start failed");
        }
        advanceToNext();
      }, 100);
    } else {
      skipStep("gateway", "manual start needed");
      advanceToNext();
    }
  }

  function runOllamaCheck() {
    setTimeout(() => {
      const result = checkOllama();
      dataRef.current.ollamaFound = result.installed;
      if (result.installed) {
        completeStep("ollama", `v${result.version}`);
        advanceToNext();
      } else {
        setPhase("ask_install");
      }
    }, 200);
  }

  function handleOllamaInstall(yes) {
    if (yes) {
      updateStep("ollama", { status: "active", detail: "installing via brew..." });
      setTimeout(() => {
        const brewResult = tryExec("brew install ollama", { timeout: 120000 });
        if (brewResult !== null) {
          updateStep("ollama", { status: "active", detail: "pulling llama3.2..." });
          setTimeout(() => {
            // Start ollama serve in background first, then pull
            tryExec("brew services start ollama", { timeout: 15000 });
            // Give it a moment to start
            setTimeout(() => {
              const pullResult = tryExec("ollama pull llama3.2", { timeout: 300000 });
              if (pullResult !== null) {
                dataRef.current.ollamaFound = true;
                completeStep("ollama", "installed + llama3.2 pulled");
              } else {
                dataRef.current.ollamaFound = true;
                completeStep("ollama", "installed (pull llama3.2 manually)");
              }
              advanceToNext();
            }, 3000);
          }, 100);
        } else {
          failStep("ollama", "brew install failed");
          advanceToNext();
        }
      }, 100);
    } else {
      skipStep("ollama", "optional, skipped");
      advanceToNext();
    }
  }

  function runClaudeCheck() {
    setTimeout(() => {
      const result = checkClaude();
      dataRef.current.claudeFound = result.installed;
      if (result.installed) {
        completeStep("claude", `v${result.version}`);
      } else {
        skipStep("claude", "not found (optional)");
      }
      advanceToNext();
    }, 200);
  }

  // Config step is multi-phase: ask for API key, then optional tokens
  function handleAnthropicKey(val) {
    const key = val.trim();
    if (!key && !dataRef.current.claudeFound) {
      // No key and no Claude CLI — re-prompt, they need at least one
      updateStep("config", { status: "active", detail: "need a key or Claude CLI subscription" });
      setPhase("ask_anthropic_key");
      return;
    }
    dataRef.current.anthropicKey = key;
    setPhase("ask_slack_token");
  }

  function handleSlackToken(val) {
    dataRef.current.slackToken = val.trim();
    setPhase("ask_telegram_token");
  }

  function handleTelegramToken(val) {
    dataRef.current.telegramToken = val.trim();
    setPhase("write_config");
  }

  // Write config files when all tokens collected
  useEffect(() => {
    if (phase !== "write_config") return;
    if (STEP_DEFS[currentStepIdx]?.id !== "config") return;

    updateStep("config", { status: "active", detail: "writing config files..." });

    setTimeout(() => {
      try {
        // Ensure config dir exists first
        ensureDirs();

        const token = dataRef.current.gatewayToken;

        // familiar.json
        const ocConfig = generateGatewayConfig({ token });
        writeFileSync(configPath(), JSON.stringify(ocConfig, null, 2) + "\n", "utf-8");

        // .env
        const envContent = generateEnvFile({
          anthropicKey: dataRef.current.anthropicKey,
          gatewayToken: token,
          slackToken: dataRef.current.slackToken,
          telegramToken: dataRef.current.telegramToken,
        });
        writeFileSync(envFilePath(), envContent, "utf-8");

        // mcp-tools.json
        const mcpConfig = generateMcpToolsConfig();
        writeFileSync(mcpToolsPath(), JSON.stringify(mcpConfig, null, 2) + "\n", "utf-8");

        completeStep("config", "3 files written");
        advanceToNext();
      } catch (err) {
        failStep("config", err.message);
        advanceToNext();
      }
    }, 200);
  }, [phase, currentStepIdx]);

  function runDirectories() {
    setTimeout(() => {
      try {
        ensureDirs();
        completeStep("directories", "all directories created");
        advanceToNext();
      } catch (err) {
        failStep("directories", err.message);
        advanceToNext();
      }
    }, 200);
  }

  // MCP bridge step
  useEffect(() => {
    if (STEP_DEFS[currentStepIdx]?.id !== "mcp_bridge") return;
    if (phase !== "init") return;

    if (!dataRef.current.claudeFound) {
      skipStep("mcp_bridge", "claude CLI not found");
      advanceToNext();
      return;
    }

    updateStep("mcp_bridge", { status: "active", detail: "installing dependencies..." });

    setTimeout(() => {
      try {
        // Auto-install mcp-bridge npm dependencies
        const repoRoot = resolve(__dirname, "../../..");
        const bridgeDir = resolve(repoRoot, "mcp-bridge");
        if (existsSync(resolve(bridgeDir, "package.json"))) {
          const npmBin = whichSync("npm") || "npm";
          tryExec(`"${npmBin}" install`, { timeout: 60000, cwd: bridgeDir });
        }

        updateStep("mcp_bridge", { status: "active", detail: "registering with claude..." });

        const bridgePath = resolve(repoRoot, "mcp-bridge", "index.mjs");
        const bunPath = whichSync("bun") || "bun";

        // Remove existing registration first (ignore errors)
        tryExec(`claude mcp remove familiar`, { timeout: 10000 });

        const result = tryExec(
          `claude mcp add familiar "${bunPath}" "${bridgePath}"`,
          { timeout: 15000 }
        );

        if (result !== null) {
          completeStep("mcp_bridge", "registered as claude MCP server");
        } else {
          // Try without checking result - some versions don't output anything
          completeStep("mcp_bridge", "registration attempted");
        }
      } catch (err) {
        failStep("mcp_bridge", err.message);
      }
      advanceToNext();
    }, 300);
  }, [currentStepIdx, phase]);

  function runServices() {
    if (LITE_MODE) {
      skipStep("services", "binary-only install — clone repo for full stack");
      advanceToNext();
      return;
    }

    updateStep("services", { status: "active", detail: "installing all services..." });

    setTimeout(() => {
      try {
        const repoRoot = resolve(__dirname, "../../..");
        const installScript = resolve(repoRoot, "services", "install-services.sh");

        if (!existsSync(installScript)) {
          failStep("services", "install-services.sh not found");
          advanceToNext();
          return;
        }

        const output = tryExec(`bash "${installScript}"`, {
          timeout: 60000,
          cwd: repoRoot,
        });

        if (output !== null) {
          // Count how many services were installed from the output
          const installed = (output.match(/\+ com\.familiar\./g) || []).length;
          // Restart gateway so it picks up the new config/token
          tryExec(`launchctl kickstart -k gui/$(id -u)/com.familiar.gateway`, { timeout: 10000 });
          completeStep("services", `${installed} services installed`);
        } else {
          failStep("services", "install-services.sh failed");
        }
        advanceToNext();
      } catch (err) {
        failStep("services", err.message);
        advanceToNext();
      }
    }, 300);
  }

  function runHealthCheck() {
    if (LITE_MODE) {
      skipStep("health", "binary-only install — no services to check");
      advanceToNext();
      return;
    }

    updateStep("health", { status: "active", detail: "waiting for services..." });

    let attempts = 0;
    const maxAttempts = 15;
    const healthResults = {};

    const poll = () => {
      attempts++;
      const defs = getServiceDefs();

      Promise.all(
        defs.map(async (def) => {
          const h = await checkServiceHealth(def.healthUrl);
          healthResults[def.displayName] = h.healthy;
          return { name: def.displayName, healthy: h.healthy };
        })
      ).then((results) => {
        const healthy = results.filter((r) => r.healthy);
        const total = results.length;

        updateStep("health", {
          status: "active",
          detail: `${healthy.length}/${total} healthy (attempt ${attempts}/${maxAttempts})`,
        });

        if (healthy.length === total || attempts >= maxAttempts) {
          if (healthy.length === total) {
            completeStep("health", `all ${total} services healthy`);
          } else {
            const unhealthy = results
              .filter((r) => !r.healthy)
              .map((r) => r.name);
            completeStep("health",
              `${healthy.length}/${total} healthy (${unhealthy.join(", ")} down)`);
          }
          advanceToNext();
        } else {
          setTimeout(poll, 1000);
        }
      }).catch(() => {
        if (attempts >= maxAttempts) {
          completeStep("health", "could not verify (services may still be starting)");
          advanceToNext();
        } else {
          setTimeout(poll, 1000);
        }
      });
    };

    setTimeout(poll, 1000);
  }

  function runBrainBootstrap() {
    if (LITE_MODE) {
      skipStep("brain_bootstrap", "binary-only install");
      advanceToNext();
      return;
    }

    const repoRoot = resolve(__dirname, "../../..");

    // Run async so execSync calls don't block the Ink render loop
    const runAsync = async () => {
      const completed = [];

      // Step 1: Pull nomic-embed-text if ollama is available
      if (dataRef.current.ollamaFound) {
        updateStep("brain_bootstrap", { status: "active", detail: "pulling embedding model..." });
        // Yield to let Ink render before blocking
        await new Promise((r) => setTimeout(r, 50));
        const pullResult = tryExec("ollama pull nomic-embed-text", { timeout: 300000 });
        if (pullResult !== null) completed.push("embeddings");
      }

      // Step 2: Seed RAG database
      const ingestScript = resolve(repoRoot, "brain", "rag", "ingest.mjs");
      if (existsSync(ingestScript)) {
        updateStep("brain_bootstrap", { status: "active", detail: "seeding knowledge base..." });
        await new Promise((r) => setTimeout(r, 50));
        const ingestResult = tryExec(`bun "${ingestScript}"`, {
          timeout: 120000,
          cwd: repoRoot,
        });
        if (ingestResult !== null) completed.push("RAG");
      }

      // Step 3: Run first learning cycle
      const learnerScript = resolve(repoRoot, "brain", "learner.mjs");
      if (existsSync(learnerScript) && dataRef.current.ollamaFound) {
        updateStep("brain_bootstrap", { status: "active", detail: "first learning cycle..." });
        await new Promise((r) => setTimeout(r, 50));
        const learnResult = tryExec(`bun "${learnerScript}"`, {
          timeout: 180000,
          cwd: repoRoot,
        });
        if (learnResult !== null) completed.push("learner");
      }

      if (completed.length > 0) {
        completeStep("brain_bootstrap", completed.join(" + "));
      } else {
        skipStep("brain_bootstrap", "nothing to bootstrap (ok)");
      }
      advanceToNext();
    };

    // Defer to let pending state updates flush before blocking calls
    setTimeout(() => runAsync(), 100);
  }

  // Profile step callbacks
  function handleProfileAsk(yes) {
    if (yes) {
      setPhase("ask_name");
    } else {
      skipStep("profile", "skipped");
      advanceToNext();
    }
  }

  function handleProfileName(val) {
    dataRef.current.profileName = val.trim();
    setPhase("ask_role");
  }

  function handleProfileRole(val) {
    dataRef.current.profileRole = val.trim();
    setPhase("ask_org");
  }

  function handleProfileOrg(val) {
    dataRef.current.profileOrg = val.trim();
    setPhase("ask_familiar_name");
  }

  function handleFamiliarName(val) {
    dataRef.current.familiarName = val.trim();
    setPhase("write_profile");
  }

  useEffect(() => {
    if (phase !== "write_profile") return;
    if (STEP_DEFS[currentStepIdx]?.id !== "profile") return;

    try {
      const profileData = {};
      if (dataRef.current.profileName) profileData.name = dataRef.current.profileName;
      if (dataRef.current.profileRole) profileData.role = dataRef.current.profileRole;
      if (dataRef.current.profileOrg) profileData.org = dataRef.current.profileOrg;

      // Save the familiar's name to preferences if provided
      const famName = dataRef.current.familiarName;
      if (famName) {
        setPreference("familiarName", famName, "manual");
      }

      if (Object.keys(profileData).length > 0 || famName) {
        if (Object.keys(profileData).length > 0) writeProfile("user", profileData);
        const label = famName ? `${famName} for ${profileData.name || "user"}` : `saved for ${profileData.name || "user"}`;
        completeStep("profile", label);
      } else {
        skipStep("profile", "no info provided");
      }
    } catch (err) {
      failStep("profile", err.message);
    }
    advanceToNext();
  }, [phase, currentStepIdx]);

  // ── Finish ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!finished) return;
    const timer = setTimeout(() => {
      app.exit();
    }, 500);
    return () => clearTimeout(timer);
  }, [finished, app]);

  // ── Render ────────────────────────────────────────────────────────────

  const currentStep = STEP_DEFS[currentStepIdx];

  // Determine what prompt to show
  let prompt = null;

  if (currentStep) {
    // Gateway start prompt
    if (currentStep.id === "gateway" && phase === "ask_install") {
      prompt = e(ConfirmPrompt, {
        question: "Start the gateway service?",
        defaultYes: true,
        onResult: handleGatewayInstall,
      });
    }

    // Ollama install prompt
    if (currentStep.id === "ollama" && phase === "ask_install") {
      prompt = e(Box, { flexDirection: "column" },
        e(Box, { marginLeft: 2 },
          e(Text, { color: colors.grayDim }, "(Ollama is optional - provides local LLM for simple tasks)")
        ),
        e(ConfirmPrompt, {
          question: "Install Ollama + llama3.2?",
          defaultYes: false,
          onResult: handleOllamaInstall,
        })
      );
    }

    // Config prompts
    if (currentStep.id === "config" && (phase === "init" || phase === "ask_anthropic_key")) {
      // Open the API keys page in the browser automatically
      if (phase === "init") {
        try { execSync("open https://console.anthropic.com/settings/keys", { stdio: "ignore" }); } catch {}
      }
      const hasClaude = dataRef.current.claudeFound;
      prompt = e(Box, { flexDirection: "column" },
        e(Box, { marginLeft: 2 },
          e(Text, { color: colors.grayDim },
            "Opening console.anthropic.com/settings/keys in your browser..."
          )
        ),
        hasClaude
          ? e(Box, { marginLeft: 2 },
              e(Text, { color: colors.grayDim },
                "(Claude CLI detected — press Enter to skip, the proxy will use your subscription)"
              )
            )
          : null,
        e(TextPrompt, {
          question: "ANTHROPIC_API_KEY",
          placeholder: "sk-ant-...",
          optional: hasClaude,
          onSubmit: handleAnthropicKey,
        })
      );
    }

    if (currentStep.id === "config" && phase === "ask_slack_token") {
      prompt = e(TextPrompt, {
        question: "SLACK_BOT_TOKEN",
        placeholder: "xoxb-...",
        optional: true,
        onSubmit: handleSlackToken,
      });
    }

    if (currentStep.id === "config" && phase === "ask_telegram_token") {
      prompt = e(TextPrompt, {
        question: "TELEGRAM_BOT_TOKEN",
        placeholder: "",
        optional: true,
        onSubmit: handleTelegramToken,
      });
    }

    // Profile prompts
    if (currentStep.id === "profile" && phase === "init") {
      prompt = e(ConfirmPrompt, {
        question: "Want to tell me about yourself?",
        defaultYes: true,
        onResult: handleProfileAsk,
      });
    }

    if (currentStep.id === "profile" && phase === "ask_name") {
      prompt = e(TextPrompt, {
        question: "Your name",
        placeholder: "Your name",
        onSubmit: handleProfileName,
      });
    }

    if (currentStep.id === "profile" && phase === "ask_role") {
      prompt = e(TextPrompt, {
        question: "Your role",
        placeholder: "Engineering lead",
        optional: true,
        onSubmit: handleProfileRole,
      });
    }

    if (currentStep.id === "profile" && phase === "ask_org") {
      prompt = e(TextPrompt, {
        question: "Your org",
        placeholder: "Acme Inc",
        optional: true,
        onSubmit: handleProfileOrg,
      });
    }

    if (currentStep.id === "profile" && phase === "ask_familiar_name") {
      prompt = e(TextPrompt, {
        question: "Name your familiar",
        placeholder: "Familiar",
        optional: true,
        onSubmit: handleFamiliarName,
      });
    }
  }

  return e(Box, { flexDirection: "column" },
    e(WelcomeScreen, { resuming }),
    e(StepList, { steps }),
    prompt,
    finished
      ? e(Box, { flexDirection: "column", marginTop: 1, marginLeft: 2 },
          e(Text, null, ""),
          e(Text, { color: colors.green, bold: true }, "Setup complete!"),
          e(Text, { color: colors.gray }, "Starting your familiar..."),
          LITE_MODE
            ? e(Box, { flexDirection: "column", marginTop: 1 },
                e(Text, { color: colors.cyan }, "For the full stack (gateway, tools, memory, training):"),
                e(Text, { color: colors.gray }, "  git clone https://github.com/engindearing-projects/engie.git ~/familiar"),
                e(Text, { color: colors.gray }, "  cd ~/familiar && ./setup.sh")
              )
            : null
        )
      : null
  );
}
