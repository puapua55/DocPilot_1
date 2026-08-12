function SearchPanel({ statusMessage }) {
  // TODO: Currently unused. Keep this wrapper in case document action notices return later.
  return (
    <>
      {statusMessage ? (
        <div className="inline-notice" role="status">
          {statusMessage}
        </div>
      ) : null}
    </>
  );
}

export default SearchPanel;
