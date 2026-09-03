export interface ViewerSection {
  id: string;
  label: string;
}

export interface ViewerSectionNavProps {
  sections: ViewerSection[];
}

/**
 * AV-011. Jumps to the viewer's sections.
 *
 * Buttons rather than `href="#id"` anchors: the app uses HashRouter, so a hash
 * link would be read as a route change and navigate away from the viewer — the
 * exact thing this control must not do. A button cannot navigate at all.
 *
 * Hidden below large screens, where the sections are only a scroll apart.
 */
export function ViewerSectionNav({ sections }: ViewerSectionNavProps) {
  return (
    <nav className="section-nav" aria-label="Activity sections">
      <ul className="section-nav__list">
        {sections.map((section) => (
          <li key={section.id}>
            <button
              type="button"
              className="section-nav__link"
              onClick={() =>
                document
                  .getElementById(section.id)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              {section.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
