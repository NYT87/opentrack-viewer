export interface ElementRow {
  id: string;
  name: string;
  /** Said after the name, such as why it is not drawn. */
  note?: string;
}

/**
 * The elements on a still image or a custom canvas, one row each: the name
 * selects it for editing, and Remove takes it off. A list rather than a row of
 * buttons, so a long layout reads top to bottom and each element can be
 * removed without selecting it first.
 */
export function ElementRows({
  label,
  rows,
  selectedId,
  onSelect,
  onRemove,
}: {
  label: string;
  rows: ElementRow[];
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <ul className="still-image__elements" aria-label={label}>
      {rows.map((row) => (
        <li key={row.id} className={row.id === selectedId ? 'still-image__element is-selected' : 'still-image__element'}>
          <button
            type="button"
            className="still-image__element-name"
            aria-pressed={row.id === selectedId}
            onClick={() => onSelect(row.id === selectedId ? undefined : row.id)}
          >
            {row.name}
            {row.note && <span className="overlay-controls__hint"> — {row.note}</span>}
          </button>
          <button type="button" className="button" aria-label={`Remove ${row.name}`} onClick={() => onRemove(row.id)}>
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}
