// Outer selected groups override descendants without rewriting their saved choices.
export function controllingGroup(components, componentId) {
  const byId = new Map(components.map((component) => [component.id, component]));
  let parentId = byId.get(componentId)?.parentId;
  let winner = null;
  const seen = new Set();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    if (parent.scope === "group" && (parent.keeper || parent.deleted)) winner = parent;
    parentId = parent.parentId;
  }
  return winner;
}

export function comparisonComponents(doc, pane) {
  return doc.state[pane].map((state) => ({
    ...doc.provenance.panes[pane].components.find((component) => component.id === state.id), ...state,
  }));
}

// Preserve layout and children when only the frame decoration is discarded.
export const FRAME_RESET = {
  background: "transparent", border: "0", "border-radius": "0", "box-shadow": "none", outline: "none", padding: "0",
};
