const FEATURES = [
  { key: 'search', label: '정확한 문서 검색' },
  { key: 'highlight', label: '위치 하이라이트' },
  { key: 'replace', label: '즉시 텍스트 교체' }
];

function FeatureButtons({ onFeatureClick }) {
  // TODO: Currently unused. Keep this component available in case document action buttons return later.
  return (
    <div className="feature-buttons">
      {FEATURES.map((feature) => (
        <button
          key={feature.key}
          type="button"
          className="feature-button"
          onClick={() => onFeatureClick(feature.key)}
        >
          {feature.label}
        </button>
      ))}
    </div>
  );
}

export default FeatureButtons;
