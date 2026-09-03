import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileDropZone } from './FileDropZone';
import { fixtureFile } from '../test/helpers/fixtures';

describe('FileDropZone (AV-102)', () => {
  it('states that files are not uploaded', () => {
    render(<FileDropZone onFile={vi.fn()} />);

    expect(screen.getByText(/nothing is uploaded/i)).toBeInTheDocument();
  });

  it('accepts a file chosen through the picker', async () => {
    const onFile = vi.fn();
    render(<FileDropZone onFile={onFile} />);

    await userEvent.upload(screen.getByTestId('file-input'), fixtureFile('simple-route.gpx'));

    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile.mock.calls[0]?.[0]).toBeInstanceOf(File);
  });

  it('accepts a dropped file', () => {
    const onFile = vi.fn();
    render(<FileDropZone onFile={onFile} />);
    const file = fixtureFile('simple-route.gpx');

    fireEvent.drop(screen.getByRole('button'), { dataTransfer: { files: [file] } });

    expect(onFile).toHaveBeenCalledWith(file);
  });

  it('rejects an unsupported extension with visible feedback', () => {
    const onFile = vi.fn();
    render(<FileDropZone onFile={onFile} />);

    fireEvent.drop(screen.getByRole('button'), {
      dataTransfer: { files: [fixtureFile('not-gpx.txt', 'text/plain')] },
    });

    expect(onFile).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/not supported/i);
  });

  it('makes no network request when a file is provided', () => {
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      render(<FileDropZone onFile={vi.fn()} />);
      fireEvent.drop(screen.getByRole('button'), {
        dataTransfer: { files: [fixtureFile('simple-route.gpx')] },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores input while disabled', () => {
    const onFile = vi.fn();
    render(<FileDropZone onFile={onFile} disabled />);

    fireEvent.drop(screen.getByRole('button'), {
      dataTransfer: { files: [fixtureFile('simple-route.gpx')] },
    });

    expect(onFile).not.toHaveBeenCalled();
  });
});
