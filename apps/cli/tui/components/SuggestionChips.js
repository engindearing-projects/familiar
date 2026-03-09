// Horizontal row of suggestion chips below assistant messages.
// Arrow keys navigate, Enter selects -> inserts into input.

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { colors } from "../lib/theme.js";

const e = React.createElement;

export function SuggestionChips({ suggestions, onSelect }) {
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (!suggestions || suggestions.length === 0) return;

    if (key.leftArrow) {
      setSelected((i) => (i > 0 ? i - 1 : suggestions.length - 1));
    } else if (key.rightArrow) {
      setSelected((i) => (i < suggestions.length - 1 ? i + 1 : 0));
    } else if (key.return) {
      onSelect(suggestions[selected]);
      setSelected(0);
    }
  });

  if (!suggestions || suggestions.length === 0) return null;

  return e(Box, { marginLeft: 2, marginTop: 0, marginBottom: 1 },
    e(Text, { color: colors.gray }, "try: "),
    ...suggestions.map((s, i) =>
      e(Text, {
        key: i,
        color: i === selected ? colors.cyan : colors.gray,
        bold: i === selected,
      }, `${s}  `)
    )
  );
}
