export default function DocxTableActionIcon({ action }) {
  const grid = <>
    <rect x="2" y="2" width="20" height="20" rx="2" />
    <path d="M12 2v20M2 12h20" />
  </>;
  const marks = {
    insertRowAbove: <><path d="M2 9h20" strokeWidth="2" /><path d="M12 7V2m-2.5 2.5L12 2l2.5 2.5" /></>,
    insertRow: <><path d="M2 15h20" strokeWidth="2" /><path d="M12 17v5m-2.5-2.5L12 22l2.5-2.5" /></>,
    insertColumnLeft: <><path d="M9 2v20" strokeWidth="2" /><path d="M7 12H2m2.5-2.5L2 12l2.5 2.5" /></>,
    insertColumn: <><path d="M15 2v20" strokeWidth="2" /><path d="M17 12h5m-2.5-2.5L22 12l-2.5 2.5" /></>,
    deleteRow: <><path d="M2 17h20M8 19h8" strokeWidth="2" /></>,
    deleteColumn: <><path d="M17 2v20M19 8v8" strokeWidth="2" /></>,
    mergeRight: <><path d="M5 7l4 5-4 5m14-10l-4 5 4 5" strokeWidth="1.8" /></>,
    mergeRange: <><path d="M7 7l4 4m6-4l-4 4M7 17l4-4m6 4l-4-4" strokeWidth="1.7" /></>,
    splitHorizontal: <path d="M12 2v20" strokeWidth="2" strokeDasharray="2 2" />,
    splitVertical: <path d="M2 12h20" strokeWidth="2" strokeDasharray="2 2" />,
    splitCell: <><path d="M12 2v20M2 12h20" strokeWidth="1.7" strokeDasharray="2 2" /></>
  };
  return <svg className="docx-table-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {action === 'splitCell' ? <rect x="2" y="2" width="20" height="20" rx="2" /> : grid}
    {marks[action]}
  </svg>;
}
