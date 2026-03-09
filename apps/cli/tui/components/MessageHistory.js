import React from "react";
import { Box, Static, Text } from "ink";
import { colors } from "../lib/theme.js";
import { UserMessage } from "./UserMessage.js";
import { AssistantMessage } from "./AssistantMessage.js";
import { SystemMessage } from "./SystemMessage.js";
import { ThoughtMessage } from "./ThoughtMessage.js";

const e = React.createElement;

export function MessageHistory({ messages }) {
  return e(Static, { items: messages },
    (msg) => {
      if (msg.role === "user") {
        return e(UserMessage, { key: msg.id, text: msg.text });
      }
      if (msg.role === "queued") {
        return e(QueuedMessage, { key: msg.id, text: msg.text });
      }
      if (msg.role === "system") {
        return e(SystemMessage, { key: msg.id, text: msg.text });
      }
      if (msg.role === "thought") {
        return e(ThoughtMessage, { key: msg.id, text: msg.text });
      }
      return e(AssistantMessage, { key: msg.id, text: msg.text });
    }
  );
}

function QueuedMessage({ text }) {
  return e(Box, { marginLeft: 2, marginTop: 1 },
    e(Text, { color: colors.grayDim, dimColor: true }, "you"),
    e(Text, { color: colors.grayDim, dimColor: true }, " > "),
    e(Text, { color: colors.grayDim, dimColor: true }, text),
    e(Text, { color: colors.yellow }, " (queued)")
  );
}
