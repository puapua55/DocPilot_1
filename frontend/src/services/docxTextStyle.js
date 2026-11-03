// text-decoration propagates visually, but is not inherited in computed style.
// A nested font/span inside <u>/<s> therefore needs its ancestors inspected.
export function readDocxTextStyle(element, root) {
  const view = element.ownerDocument.defaultView;
  const style = view.getComputedStyle(element);
  const decorations = new Set();
  for (let node = element; node; node = node.parentElement) {
    const line = view.getComputedStyle(node).textDecorationLine || '';
    line.split(/\s+/).filter(value => value && value !== 'none').forEach(value => decorations.add(value));
    if (node.tagName === 'U') decorations.add('underline');
    if (['S', 'STRIKE', 'DEL'].includes(node.tagName)) decorations.add('line-through');
    if (node === root) break;
  }
  return { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
    fontStyle: style.fontStyle, color: style.color, letterSpacing: style.letterSpacing,
    textDecorationLine: [...decorations].join(' ') || 'none' };
}

export function materializeDocxDecorations(root) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parents = new Set();
  while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) parents.add(walker.currentNode.parentElement);
  // Read before writing so one descendant does not affect another's snapshot.
  const styles = [...parents].map(element => [element, readDocxTextStyle(element, root).textDecorationLine]);
  styles.forEach(([element, line]) => { element.style.textDecorationLine = line; });
}
