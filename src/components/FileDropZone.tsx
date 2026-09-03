import { useCallback, useId, useRef, useState } from 'react';

export interface FileDropZoneProps {
  onFile: (file: File) => void;
  /** Lowercase extensions accepted by the current build. */
  acceptedExtensions?: string[];
  disabled?: boolean;
}

/**
 * AV-102. Local file intake via picker and drag/drop. The File object is handed
 * straight to the parser — this component never issues a network request and
 * never creates an object URL it does not revoke.
 */
export function FileDropZone({
  onFile,
  acceptedExtensions = ['gpx'],
  disabled = false,
}: FileDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [isDragging, setIsDragging] = useState(false);
  const [rejection, setRejection] = useState<string | undefined>();

  const accept = acceptedExtensions.map((extension) => `.${extension}`).join(',');

  const handleFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      const extension = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
      if (!acceptedExtensions.includes(extension)) {
        setRejection(
          `"${file.name}" is not supported. Choose a ${acceptedExtensions
            .map((value) => `.${value}`)
            .join(' or ')} file.`,
        );
        return;
      }
      setRejection(undefined);
      onFile(file);
    },
    [acceptedExtensions, onFile],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      if (disabled) return;
      handleFile(event.dataTransfer.files[0]);
    },
    [disabled, handleFile],
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
        <span className="dropzone__title">Drop a GPX file here</span>
        <span className="dropzone__subtitle">or click to choose one</span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={accept}
          className="dropzone__input"
          disabled={disabled}
          onChange={(event) => {
            handleFile(event.target.files?.[0]);
            // Reset so re-selecting the same file fires change again.
            event.target.value = '';
          }}
          data-testid="file-input"
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
