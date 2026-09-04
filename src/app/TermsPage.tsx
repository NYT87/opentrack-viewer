/**
 * AV-008. Informational route. It mounts no upload, map, chart or processing
 * component, so visiting it cannot disturb a loaded activity — the store keeps
 * it in memory while this page is shown.
 */
export function TermsPage() {
  return (
    <main className="page">
      <div className="page__inner">
        <header className="page__header">
          <h2 className="page__title">Terms and Conditions</h2>
          <p className="page__intro">
            How OpenTrack Viewer handles your files, and what it does and does not promise.
          </p>
          <p className="notice" role="note">
            <strong>Draft.</strong> This text describes how the app actually behaves, but it has
            not been reviewed by a qualified legal professional. It must be reviewed before any
            production release.
          </p>
        </header>

        <section className="prose">
          <h3 className="prose__title">Your activity files stay on your device</h3>
          <p>
            Activity files you open are read, parsed and analysed entirely in your browser. They
            are not uploaded to a server, and this app has no backend, no account system and no
            database. Nothing about your activity is stored between sessions: closing the tab
            discards it.
          </p>
        </section>

        <section className="prose">
          <h3 className="prose__title">Maps are the exception</h3>
          <p>
            When the basemap is enabled, the map requests tiles from a third-party tile provider.
            Those requests reveal the approximate area you are looking at, and are subject to that
            provider&rsquo;s own terms and privacy practices. They never include your activity
            file, your route coordinates or any other data from it. You can turn the basemap off
            in Settings, which stops all external requests.
          </p>
        </section>

        <section className="prose">
          <h3 className="prose__title">No warranty</h3>
          <p>
            This software is provided &ldquo;as is&rdquo;, without warranty of any kind, express
            or implied. It may contain errors, may misread a file, and may be unavailable at any
            time.
          </p>
        </section>

        <section className="prose">
          <h3 className="prose__title">Not medical or training advice</h3>
          <p>
            Distances, durations, elevation, pace, cadence and every other figure shown are
            derived from the file you opened and are approximations. Nothing here is medical
            advice, fitness advice or a training recommendation. Do not rely on it for decisions
            about your health, and consult a qualified professional instead.
          </p>
        </section>

        <section className="prose">
          <h3 className="prose__title">Your files are your responsibility</h3>
          <p>
            You are responsible for the files you open and for keeping your own copies. This app
            does not store, back up or recover them, and it will not modify the file you opened.
            Only open files you have the right to use.
          </p>
        </section>

        <section className="prose">
          <h3 className="prose__title">Supported formats</h3>
          <p>
            GPX is the only format this build reads. Support for FIT and TCX is planned but not
            available yet, and a file that cannot be read will be reported rather than partially
            interpreted. Even for GPX, the app can only show what a file actually contains: fields
            a device did not record cannot be reconstructed.
          </p>
        </section>
      </div>
    </main>
  );
}
