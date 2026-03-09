// Trigger cascade — evaluates local context to find the most urgent thing to work on.
// Used by both the TUI auto-continuation hook and the background daemon.
//
// Priority order (first match wins):
//   1. Open todos           (100)
//   2. Blockers             (90)
//   3. HANDOFF.md           (80)
//   4. Stale Jira tickets   (70)
//   5. Repo/PR health       (60)
//   6. Proactive suggest    (50)
//   7. Training data        (40) — collect new pairs when unused count is low
//   8. Model training       (30) — train when enough new data has accumulated
//   9. Weight tuning        (25) — benchmark after training, compare versions
//  10. Code tests           (20) — run test suites on active repos

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { getByType, search, getRecentAll } from "../apps/cli/lib/memory-db.js";
import { workspaceDir } from "../apps/cli/lib/paths.js";

// Forge DB is optional — daemon can run without training infra
let forgeDb = null;
try {
  forgeDb = await import("../trainer/forge-db.js");
} catch { /* forge not installed or DB not available */ }

const TRAINING_DATA_THRESHOLD = 50;   // Minimum unused pairs to trigger training
const STALE_DATA_COLLECTION_HOURS = 6; // Collect if no new raw data in this window
const STALE_TRAINING_HOURS = 24;       // Train if no run in this window
const STALE_EVAL_HOURS = 48;           // Benchmark if no eval in this window

/**
 * Evaluate all triggers in priority order. Returns the first match or null.
 * All checks are local (SQLite + filesystem) — instant, no network calls.
 *
 * @returns {{ trigger: string, prompt: string, priority: number } | null}
 */
export function evaluateTriggers() {
  // 1. Open todos (priority 100)
  try {
    const todos = getByType("todo", 5);
    if (todos.length > 0) {
      const list = todos.map((t) => t.summary).join(", ");
      return {
        trigger: "todo",
        prompt: `Open todos: ${list}. Pick the most urgent and work on it.`,
        priority: 100,
      };
    }
  } catch { /* db not available */ }

  // 2. Blockers (priority 90)
  try {
    const blockers = getByType("blocker", 3);
    if (blockers.length > 0) {
      const list = blockers.map((b) => b.summary).join(", ");
      return {
        trigger: "blocker",
        prompt: `Open blockers: ${list}. Check if any have been resolved and update status.`,
        priority: 90,
      };
    }
  } catch { /* db not available */ }

  // 3. HANDOFF.md (priority 80)
  try {
    const handoffPath = join(workspaceDir(), "HANDOFF.md");
    if (existsSync(handoffPath)) {
      const content = readFileSync(handoffPath, "utf-8").trim();
      if (content) {
        const truncated = content.length > 500 ? content.slice(0, 500) + "..." : content;
        return {
          trigger: "handoff",
          prompt: `Continue from handoff:\n${truncated}`,
          priority: 80,
        };
      }
    }
  } catch { /* file not readable */ }

  // 4. Stale Jira tickets — task_updates with ticket refs (priority 70)
  try {
    const updates = getByType("task_update", 10);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const stale = updates.filter((u) => u.timestamp < threeDaysAgo);
    if (stale.length > 0) {
      const ticketRefs = stale
        .map((u) => u.summary.match(/[A-Z]+-\d+/))
        .filter(Boolean)
        .map((m) => m[0]);
      const unique = [...new Set(ticketRefs)];
      if (unique.length > 0) {
        return {
          trigger: "stale_ticket",
          prompt: `${unique[0]} was last updated ${timeAgo(stale[0].timestamp)}. Check Jira for current status and see if it needs attention.`,
          priority: 70,
        };
      }
    }
  } catch { /* db not available */ }

  // 5. Repo health — search for PR-related observations (priority 60)
  try {
    const prObs = search("PR", { limit: 5 });
    if (prObs.length > 0) {
      return {
        trigger: "repo_health",
        prompt: `Check open PRs on active repos and see if any need review or have stale comments.`,
        priority: 60,
      };
    }
  } catch { /* search may fail if no FTS matches */ }

  // 5.5. Stale goals — goals not updated in 24h (priority 55)
  try {
    const goalsPath = join(process.env.FAMILIAR_HOME || process.env.COZYTERM_HOME || join(process.env.HOME || "/tmp", ".familiar"), "goals.json");
    if (existsSync(goalsPath)) {
      const goals = JSON.parse(readFileSync(goalsPath, "utf-8"));
      const stale = goals.filter((g) => {
        if (g.status !== "active") return false;
        const age = Date.now() - new Date(g.updatedAt).getTime();
        return age > 24 * 60 * 60 * 1000;
      });
      if (stale.length > 0) {
        const hours = Math.round((Date.now() - new Date(stale[0].updatedAt).getTime()) / 3600000);
        return {
          trigger: "goal_stale",
          prompt: `Goal "${stale[0].title}" (P${stale[0].priority}) hasn't been checked in ${hours}h. Review its status and determine if action is needed.`,
          priority: 55,
        };
      }
    }
  } catch { /* goals system not yet installed */ }

  // 6. Proactive suggestions — build from recent context (priority 50)
  try {
    const recent = getRecentAll(10);
    if (recent.length > 0) {
      const topics = recent.slice(0, 5).map((r) => r.summary).join("; ");
      return {
        trigger: "proactive",
        prompt: `Based on recent work (${topics}), suggest 2-3 things worth looking into — improvements, follow-ups, or things that might need attention.`,
        priority: 50,
      };
    }
  } catch { /* db not available */ }

  // ── Forge Training Triggers (lower priority, fill idle time) ──────────

  // 7. Training data collection (priority 40)
  const dataResult = checkTrainingData();
  if (dataResult) return dataResult;

  // 8. Model training (priority 30)
  const trainResult = checkModelTraining();
  if (trainResult) return trainResult;

  // 9. Weight tuning / benchmarking (priority 25)
  const evalResult = checkWeightTuning();
  if (evalResult) return evalResult;

  // 10. Code tests (priority 20)
  const testResult = checkCodeTests();
  if (testResult) return testResult;

  return null;
}

// ── Forge: Training Data Collection ──────────────────────────────────────

function checkTrainingData() {
  if (!forgeDb) return null;

  try {
    const stats = forgeDb.getForgeStats();

    // Check if raw data collection has gone stale
    const rawDir = join(process.env.HOME || "/tmp", "familiar/trainer/data/raw");
    if (existsSync(rawDir)) {
      const files = readdirSync(rawDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse();

      if (files.length > 0) {
        const latestFile = join(rawDir, files[0]);
        const fileStat = statSync(latestFile);
        const hoursSinceLastData = (Date.now() - fileStat.mtimeMs) / (60 * 60 * 1000);

        if (hoursSinceLastData > STALE_DATA_COLLECTION_HOURS) {
          return {
            trigger: "training_data",
            prompt: `Training data collection appears stale — last raw data file (${files[0]}) was modified ${Math.round(hoursSinceLastData)}h ago. Current stats: ${stats.totalPairs} total pairs, ${stats.unusedPairs} unused. Run the collector to capture new Claude Code session pairs, or mine GitHub repos for ground-truth examples (forge-cli.mjs mine-gt). Check if the collector is running and connected to the router.`,
            priority: 40,
          };
        }
      }
    }

    // If unused pair count is very low, suggest mining more data
    if (stats.unusedPairs < 20 && stats.totalPairs > 0) {
      return {
        trigger: "training_data",
        prompt: `Only ${stats.unusedPairs} unused training pairs remaining (${stats.totalPairs} total). Mine new training data: run \`bun ~/familiar/trainer/forge-cli.mjs mine-gt\` for ground-truth PR examples, or \`bun ~/familiar/trainer/forge-cli.mjs mine-top\` for top GitHub repos. Also check if the auto-collector is active and capturing new session pairs.`,
        priority: 40,
      };
    }
  } catch { /* forge DB not available */ }

  return null;
}

// ── Forge: Model Training ────────────────────────────────────────────────

function checkModelTraining() {
  if (!forgeDb) return null;

  try {
    const stats = forgeDb.getForgeStats();
    const lastRun = stats.lastRun;

    // Don't trigger if not enough data
    if (stats.unusedPairs < TRAINING_DATA_THRESHOLD) return null;

    // Check when the last training run happened
    if (lastRun?.completed_at) {
      const hoursSinceLastRun = (Date.now() - new Date(lastRun.completed_at).getTime()) / (60 * 60 * 1000);

      if (hoursSinceLastRun > STALE_TRAINING_HOURS) {
        const activeVersion = stats.activeVersion;
        return {
          trigger: "model_training",
          prompt: `${stats.unusedPairs} unused training pairs available and last training run was ${Math.round(hoursSinceLastRun)}h ago (${lastRun.version}, loss: ${lastRun.valid_loss?.toFixed(3) || "?"}). Current active model: ${activeVersion?.version || "unknown"}. Consider running a new training cycle: prepare data, fine-tune, evaluate, and deploy. Run \`bun ~/familiar/trainer/forge-cli.mjs train\` for the full pipeline. Check if the nightly cron (2 AM) is configured to handle this automatically.`,
          priority: 30,
        };
      }
    } else if (!lastRun) {
      // No training run has ever completed, but we have data
      return {
        trigger: "model_training",
        prompt: `${stats.unusedPairs} unused training pairs available but no completed training runs found. The forge pipeline may need initialization. Run \`bun ~/familiar/trainer/forge-cli.mjs status\` to check the current state, then \`bun ~/familiar/trainer/forge-cli.mjs train\` to kick off a training run.`,
        priority: 30,
      };
    }

    // Check for stuck/failed runs
    if (lastRun?.status === "running") {
      const hoursSinceStart = (Date.now() - new Date(lastRun.started_at).getTime()) / (60 * 60 * 1000);
      if (hoursSinceStart > 4) {
        return {
          trigger: "model_training",
          prompt: `Training run ${lastRun.version} appears stuck — started ${Math.round(hoursSinceStart)}h ago and still in 'running' status. Check if the process is alive, look at training logs in ~/familiar/trainer/logs/, and consider failing the run in the forge DB so a new one can be started.`,
          priority: 30,
        };
      }
    }

    if (lastRun?.status === "failed") {
      return {
        trigger: "model_training",
        prompt: `Last training run ${lastRun.version} failed. ${stats.unusedPairs} unused pairs waiting. Check logs in ~/familiar/trainer/logs/ for the failure reason. Common issues: OOM on Metal GPU (reduce --max-seq-length), Ollama still loaded (needs to be stopped before training), or data format issues. Fix the issue and retry with \`bun ~/familiar/trainer/forge-cli.mjs train\`.`,
        priority: 30,
      };
    }
  } catch { /* forge DB not available */ }

  return null;
}

// ── Forge: Weight Tuning / Benchmarking ──────────────────────────────────

function checkWeightTuning() {
  if (!forgeDb) return null;

  try {
    const activeVersion = forgeDb.getActiveVersion();
    if (!activeVersion) return null;

    // Check if the active version has been evaluated
    const latestEval = forgeDb.getLatestEvaluation(activeVersion.version);

    if (!latestEval) {
      return {
        trigger: "weight_tuning",
        prompt: `Active model ${activeVersion.version} has no benchmark evaluation. Run \`bun ~/familiar/trainer/forge-cli.mjs eval\` to benchmark it against coding-tasks.jsonl. This scores syntax validity, test passing, similarity, and completeness. Results will be stored in the forge DB for version comparison.`,
        priority: 25,
      };
    }

    // Check if evaluation is stale
    const hoursSinceEval = (Date.now() - new Date(latestEval.evaluated_at).getTime()) / (60 * 60 * 1000);
    if (hoursSinceEval > STALE_EVAL_HOURS) {
      // Check if there are newer versions that haven't been evaluated
      const allVersions = forgeDb.getAllVersions();
      const allEvals = forgeDb.getAllEvaluations();
      const evaluatedVersions = new Set(allEvals.map((e) => e.version));
      const unevaluated = allVersions.filter((v) => !evaluatedVersions.has(v.version));

      if (unevaluated.length > 0) {
        return {
          trigger: "weight_tuning",
          prompt: `${unevaluated.length} model version(s) haven't been benchmarked: ${unevaluated.map((v) => v.version).join(", ")}. Run \`bun ~/familiar/trainer/forge-cli.mjs eval\` to score them. Compare against active model ${activeVersion.version} (score: ${latestEval.overall_score?.toFixed(1) || "?"}). If a newer version scores higher, consider deploying it with \`bun ~/familiar/trainer/forge-cli.mjs deploy\`.`,
          priority: 25,
        };
      }

      // Run self-iteration to generate new benchmark traces
      return {
        trigger: "weight_tuning",
        prompt: `Last benchmark for ${activeVersion.version} was ${Math.round(hoursSinceEval)}h ago (score: ${latestEval.overall_score?.toFixed(1) || "?"}). Run a self-iteration loop to test the model on real coding tasks and collect training traces: \`bun ~/familiar/trainer/self-iterate.mjs\`. This generates new data points and identifies where the model struggles.`,
        priority: 25,
      };
    }
  } catch { /* forge DB not available */ }

  return null;
}

// ── Code Tests ───────────────────────────────────────────────────────────

function checkCodeTests() {
  // Check for active repos with test suites that haven't been run recently
  try {
    const codeChanges = getByType("code_change", 5);
    if (codeChanges.length === 0) return null;

    // Look for recent code changes that might need test verification
    const recentChanges = codeChanges.filter((c) => {
      const age = Date.now() - new Date(c.timestamp).getTime();
      return age < 24 * 60 * 60 * 1000; // Last 24h
    });

    if (recentChanges.length > 0) {
      const projects = [...new Set(recentChanges.map((c) => c.project).filter(Boolean))];
      if (projects.length > 0) {
        return {
          trigger: "code_tests",
          prompt: `Recent code changes detected in ${projects.join(", ")}. Run the test suite to verify nothing is broken. Check for failing tests, lint errors, or type errors. If tests pass, no action needed.`,
          priority: 20,
        };
      }

      // No project names, but still have changes
      const summaries = recentChanges.slice(0, 3).map((c) => c.summary).join("; ");
      return {
        trigger: "code_tests",
        prompt: `Recent code changes: ${summaries}. Run relevant test suites to verify these changes haven't introduced regressions. Check package.json for test scripts in affected repos.`,
        priority: 20,
      };
    }
  } catch { /* db not available */ }

  return null;
}

/**
 * Format an ISO timestamp as a human-readable "time ago" string.
 * @param {string} isoStr - ISO 8601 timestamp
 * @returns {string}
 */
export function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
