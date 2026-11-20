// jsdom has no layout engine. Supply the Range geometry methods CodeMirror
// needs for selection/undo tests; real scrolling/layout is checked natively.
if (!Range.prototype.getClientRects) Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => Object.assign([], { item: () => null }) });
if (!Range.prototype.getBoundingClientRect) Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
