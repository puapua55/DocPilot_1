import FeatureButtons from './FeatureButtons';

function SearchPanel({ statusMessage, onFeatureClick }) {
  return (
    <>
      <FeatureButtons onFeatureClick={onFeatureClick} />
      {statusMessage ? (
        <div className="inline-notice" role="status">
          {statusMessage}
        </div>
      ) : null}
    </>
  );
}

export default SearchPanel;
