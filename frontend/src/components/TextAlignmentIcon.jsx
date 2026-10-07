const LINE_ENDS = {
  left: [[2, 18], [2, 14], [2, 18], [2, 12]],
  center: [[2, 18], [4, 16], [2, 18], [5, 15]],
  right: [[2, 18], [6, 18], [2, 18], [8, 18]],
  justify: [[2, 18], [2, 18], [2, 18], [2, 18]]
};

export default function TextAlignmentIcon({ align }) {
  const lines = LINE_ENDS[align] || LINE_ENDS.left;
  return (
    <svg aria-hidden="true" focusable="false" width="20" height="18" viewBox="0 0 20 18" fill="none">
      {lines.map(([start, end], index) => (
        <path key={index} d={`M${start} ${3 + index * 4}H${end}`} stroke="currentColor" strokeWidth="1.2" />
      ))}
    </svg>
  );
}
