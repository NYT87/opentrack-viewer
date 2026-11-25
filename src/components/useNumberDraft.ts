import { useState, type ChangeEvent } from 'react';

/**
 * AV-1210. A number field typed into a digit at a time. Its text is the
 * reader's while the field is typed in, and a value is passed on only when it
 * is within `range` (any value, without one); one outside it waits until the
 * field is left, when it is passed on held to the range. Without this, a field
 * held to 10–17 read "1" as 10 and then "12" as 102, so 17, and could not be
 * typed in at all.
 */
export function useNumberDraft(value: number, decimals: number, onChange: (value: number) => void, range?: readonly [number, number]) {
  const [draft, setDraft] = useState<string>();
  const within = (next: number) => !range || (next >= range[0] && next <= range[1]);
  return {
    value: draft ?? String(Number(value.toFixed(decimals))),
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      setDraft(event.target.value);
      const next = event.target.valueAsNumber;
      if (Number.isFinite(next) && within(next)) onChange(next);
    },
    onBlur: (event: ChangeEvent<HTMLInputElement>) => {
      setDraft(undefined);
      const next = event.target.valueAsNumber;
      if (range && Number.isFinite(next) && !within(next)) onChange(Math.min(range[1], Math.max(range[0], next)));
    },
  };
}
