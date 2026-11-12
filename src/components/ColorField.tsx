/** A colour picker with its label: `#rrggbb` in, `#rrggbb` out. */
export function ColorField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="overlay-controls__field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
