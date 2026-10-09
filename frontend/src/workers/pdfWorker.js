// Electron 38's worker context does not yet provide the Map helper used by
// PDF.js 6. The main renderer has its own Map prototype, so it cannot patch
// the worker's separate global scope.
if (typeof Map.prototype.getOrInsertComputed !== 'function') {
  Object.defineProperty(Map.prototype, 'getOrInsertComputed', {
    configurable: true,
    value(key, computeValue) {
      if (this.has(key)) return this.get(key);
      const value = computeValue(key);
      this.set(key, value);
      return value;
    }
  });
}

if (typeof Math.sumPrecise !== 'function') {
  Math.sumPrecise = (values) => {
    let sum = 0;
    let compensation = 0;
    for (const value of values) {
      const next = sum + value;
      compensation += Math.abs(sum) >= Math.abs(value)
        ? (sum - next) + value
        : (value - next) + sum;
      sum = next;
    }
    return sum + compensation;
  };
}

import('pdfjs-dist/build/pdf.worker.min.mjs');
