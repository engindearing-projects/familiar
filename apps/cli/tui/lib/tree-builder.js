// Tree builder — transforms flat file entries into nested tree with box-drawing metadata.
// Pure utility, no React or Ink deps.

/**
 * Strip the longest common directory prefix from all paths.
 * @param {Array<{path: string, status: string, toolName?: string}>} entries
 * @returns {{ prefix: string, entries: Array<{path: string, status: string, toolName?: string}> }}
 */
export function stripCommonPrefix(entries) {
  if (entries.length === 0) return { prefix: "", entries: [] };
  if (entries.length === 1) {
    const parts = entries[0].path.split("/");
    if (parts.length <= 1) return { prefix: "", entries };
    const prefix = parts.slice(0, -1).join("/");
    return { prefix, entries: [{ ...entries[0], path: parts[parts.length - 1] }] };
  }

  const splitPaths = entries.map((e) => e.path.split("/"));
  const minLen = Math.min(...splitPaths.map((p) => p.length));
  let common = 0;

  for (let i = 0; i < minLen - 1; i++) {
    const seg = splitPaths[0][i];
    if (splitPaths.every((p) => p[i] === seg)) {
      common = i + 1;
    } else {
      break;
    }
  }

  if (common === 0) return { prefix: "", entries };

  const prefix = splitPaths[0].slice(0, common).join("/");
  const stripped = entries.map((e) => ({
    ...e,
    path: e.path.split("/").slice(common).join("/"),
  }));
  return { prefix, entries: stripped };
}

/**
 * @typedef {Object} TreeNode
 * @property {string} name - Display name (may be compressed, e.g. "src/hooks")
 * @property {TreeNode[]} children
 * @property {string|null} status - "active" | "done" | null (null for dir-only nodes)
 * @property {string|null} toolName
 * @property {number} depth
 * @property {boolean} isLast - Last sibling at this level
 * @property {boolean} isDir
 */

/**
 * Build a nested tree from flat file entries.
 * Applies path compression: collapses single-child directories.
 * @param {Array<{path: string, status: string, toolName?: string}>} entries
 * @returns {TreeNode[]}
 */
export function buildTree(entries) {
  // Build raw nested map
  const root = { children: new Map(), files: [] };

  for (const entry of entries) {
    const parts = entry.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!node.children.has(seg)) {
        node.children.set(seg, { children: new Map(), files: [] });
      }
      node = node.children.get(seg);
    }
    node.files.push({
      name: parts[parts.length - 1],
      status: entry.status,
      toolName: entry.toolName || null,
    });
  }

  // Convert map to sorted array with path compression
  function toNodes(mapNode, depth) {
    const nodes = [];

    // Sort: directories first, then files, each alphabetically
    const dirEntries = [...mapNode.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const fileEntries = [...mapNode.files].sort((a, b) => a.name.localeCompare(b.name));

    for (const [dirName, child] of dirEntries) {
      // Path compression: collapse single-child dirs with no files
      let compressedName = dirName;
      let current = child;
      while (current.children.size === 1 && current.files.length === 0) {
        const [nextName, nextChild] = [...current.children.entries()][0];
        compressedName += "/" + nextName;
        current = nextChild;
      }

      const childNodes = toNodes(current, depth + 1);
      nodes.push({
        name: compressedName,
        children: childNodes,
        status: null,
        toolName: null,
        depth,
        isLast: false, // set below
        isDir: true,
      });
    }

    for (const file of fileEntries) {
      nodes.push({
        name: file.name,
        children: [],
        status: file.status,
        toolName: file.toolName,
        depth,
        isLast: false,
        isDir: false,
      });
    }

    // Mark last sibling
    if (nodes.length > 0) {
      nodes[nodes.length - 1].isLast = true;
    }

    return nodes;
  }

  return toNodes(root, 0);
}

/**
 * Flatten tree to lines for rendering.
 * Each line: { indent: string, connector: string, node: TreeNode }
 * @param {TreeNode[]} tree
 * @param {boolean} ascii - Use ASCII chars instead of Unicode box-drawing
 * @returns {Array<{indent: string, connector: string, node: TreeNode}>}
 */
export function flattenTree(tree, ascii = false) {
  const lines = [];
  const branch = ascii ? "|   " : "\u2502   ";
  const tee = ascii ? "+-- " : "\u251C\u2500 ";
  const elbow = ascii ? "\\-- " : "\u2514\u2500 ";
  const space = "    ";

  function walk(nodes, prefix) {
    for (const node of nodes) {
      const connector = node.isLast ? elbow : tee;
      lines.push({ indent: prefix, connector, node });
      if (node.children.length > 0) {
        const childPrefix = prefix + (node.isLast ? space : branch);
        walk(node.children, childPrefix);
      }
    }
  }

  walk(tree, "");
  return lines;
}

/**
 * Get a brief directory summary from entries.
 * @param {Array<{path: string}>} entries
 * @returns {{ totalFiles: number, directories: string[] }}
 */
export function summarize(entries) {
  const dirs = new Set();
  for (const e of entries) {
    const parts = e.path.split("/");
    if (parts.length > 1) {
      dirs.add(parts[0] + "/");
    }
  }
  return {
    totalFiles: entries.length,
    directories: [...dirs].sort(),
  };
}
