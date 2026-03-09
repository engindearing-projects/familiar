// Welcome screen for the setup wizard.

import React from "react";
import { Box, Text } from "ink";
import { colors, VERSION } from "../lib/theme.js";

const e = React.createElement;

export function WelcomeScreen({ resuming }) {
  return e(Box, { flexDirection: "column", marginBottom: 1 },
    e(Box, null,
      e(Text, { color: colors.cyan, bold: true }, "familiar"),
      e(Text, { color: colors.gray }, ` v${VERSION} setup`)
    ),
    e(Text, null, ""),
    resuming
      ? e(Text, { color: colors.yellow }, "  Resuming setup...")
      : e(Box, { flexDirection: "column" },
          e(Text, { color: colors.white, bold: true }, "  Hey! I'm Familiar — your personal AI, right in the terminal."),
          e(Text, { color: colors.gray },
            "  Let's get me set up. This takes about 2 minutes."),
          e(Text, null, ""),
          e(Text, { color: colors.gray }, "  Tips:"),
          e(Text, { color: colors.gray }, "    shift+tab — open the task panel (todos, active work, recent context)"),
          e(Text, { color: colors.gray }, "    /todo     — manage your todo list"),
          e(Text, { color: colors.gray }, "    /coach    — toggle friendly coaching mode"),
          e(Text, { color: colors.gray }, "    /explain  — get a warm explanation of any concept"),
          e(Text, { color: colors.gray }, "    /suggest  — get next-step suggestions"),
        )
  );
}
