import { useCallback, useId, useRef, useState } from 'react';
import { SUPPORTED_FORMATS } from '../parsers/detectFormat';

export interface FileDropZoneProps {
  onFile: (file: File) => void;
  /** Lowercase extensions accepted by the current build. */
  acceptedExtensions?: string[];
  disabled?: boolean;
  /** For a page with more than one drop zone, so tests can tell them apart. */
  testId?: string;
  /**
   * AV-1109. Take several files at once, from the picker or a drop: each
   * accepted file is handed to `onFile` in turn, and the ones refused are
   * named together.
   */
  multiple?: boolean;
}

/**
 * AV-102. Local file intake via picker and drag/drop. The File object is handed
 * straight to the parser — this component never issues a network request and
 * never creates an object URL it does not revoke.
 */
export function FileDropZone({
  onFile,
  acceptedExtensions = SUPPORTED_FORMATS,
  disabled = false,
  testId = 'file-input',
  multiple = false,
}: FileDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [isDragging, setIsDragging] = useState(false);
  const [rejection, setRejection] = useState<string | undefined>();

  const accept = acceptedExtensions.map((extension) => `.${extension}`).join(',');

  const handleFiles = useCallback(
    (list: FileList | null | undefined) => {
      const files = Array.from(list ?? []).slice(0, multiple ? undefined : 1);
      if (files.length === 0) return;
      const accepted = (file: File) =>
        acceptedExtensions.includes(file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase());
      const refused = files.filter((file) => !accepted(file));
      setRejection(
        refused.length === 0
          ? undefined
          : `${refused.map((file) => `"${file.name}"`).join(', ')} ${refused.length === 1 ? 'is' : 'are'} not supported. Choose ${describeFormats(acceptedExtensions)}.`,
      );
      files.filter(accepted).forEach((file) => onFile(file));
    },
    [acceptedExtensions, onFile, multiple],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      if (disabled) return;
      handleFiles(event.dataTransfer.files);
    },
    [disabled, handleFiles],
  );

  return (
    <div className="dropzone">
      <div
        className={`dropzone__target${isDragging ? ' is-dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        role="button"
        tabIndex={0}
        aria-disabled={disabled}
        aria-describedby={`${inputId}-hint`}
      >
        <span className="dropzone__title">
          Drop{' '}
          {multiple
            ? describeFormats(acceptedExtensions).replace(/^an? /, '').replace(/ file$/, ' files')
            : describeFormats(acceptedExtensions)}{' '}
          here
        </span>
        {/* "Choose", not "click": it is pressed, tapped or chosen with Enter. */}
        <span className="dropzone__subtitle">{multiple ? 'or choose them' : 'or choose one'}</span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={accept}
          multiple={multiple}
          className="dropzone__input"
          disabled={disabled}
          onChange={(event) => {
            handleFiles(event.target.files);
            // Reset so re-selecting the same file fires change again.
            event.target.value = '';
          }}
          data-testid={testId}
        />
      </div>

      <p id={`${inputId}-hint`} className="dropzone__hint">
        Files are read on your device. Nothing is uploaded.
      </p>

      {rejection && (
        <p className="dropzone__rejection" role="alert">
          {rejection}
        </p>
      )}
    </div>
  );
}

/** "a GPX file", "a GPX or FIT file", "a GPX, FIT or TCX file". */
export function describeFormats(extensions: readonly string[]): string {
  const names = extensions.map((extension) => extension.toUpperCase());
  if (names.length === 0) return 'a file';
  const joined =
    names.length === 1
      ? names[0]!
      : `${names.slice(0, -1).join(', ')} or ${names.at(-1)!}`;
  // Said as it is read aloud: "an MP4", spelled out, but "a GPX" and "a FIT".
  const article = /^(?:[AEIOU]|MP|M4)/.test(joined) ? 'an' : 'a';
  return `${article} ${joined} file`;
}
