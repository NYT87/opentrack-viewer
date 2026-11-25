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
/** Whether the reader has asked the system for less motion. */
function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Scrolls to a section and moves focus into it (TD-056). Scrolling alone left
 * focus on the link, so the next Tab went back through the sidebar rather than
 * into the section the reader asked for. The scroll is instant for a reader
 * who has asked for reduced motion.
 */
function jumpTo(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  target.focus({ preventScroll: true });
}

export function ViewerSectionNav({ sections }: ViewerSectionNavProps) {
  return (
    <nav className="section-nav" aria-label="Activity sections">
      <ul className="section-nav__list">
        {sections.map((section) => (
          <li key={section.id}>
            <button
              type="button"
              className="section-nav__link"
              onClick={() => jumpTo(section.id)}
            >
              {section.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
