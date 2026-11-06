import React, { useRef, useState } from 'react';
import { Upload, Trash2 } from 'lucide-react';
import { Button, useToast } from '@/components/ui';
import type { UploadedImage } from '@/api/client';
import { ACCEPTED_IMAGE_TYPES as ACCEPT, imageFileProblem } from '@/lib/imageFile';

// One image (business logo, staff photo): preview, choose a file, remove. The browser checks type and size first for
// a quick answer; the server checks the file's actual bytes and is the one that decides.

interface Props {
  label: string;
  /** Current image URL, if any. */
  value: string | null;
  upload: (file: File) => Promise<UploadedImage>;
  remove: () => Promise<unknown>;
  onChange: (url: string | null) => void;
  shape?: 'square' | 'round';
  disabled?: boolean;
}

export function ImageUpload({ label, value, upload, remove, onChange, shape = 'square', disabled }: Props) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `image-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  async function choose(file: File | undefined) {
    if (!file) return;
    const problem = imageFileProblem(file);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      const saved = await upload(file);
      onChange(saved.url);
      toast.success(`${label} updated`);
    } catch (e) {
      setError((e as Error).message || 'The image could not be uploaded.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      await remove();
      onChange(null);
      toast.success(`${label} removed`);
    } catch (e) {
      setError((e as Error).message || 'The image could not be removed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p id={`${id}-label`} className="text-sm font-medium text-text-primary mb-2">{label}</p>
      <div className="flex flex-wrap items-center gap-4">
        <div className={`w-20 h-20 bg-muted border border-border flex items-center justify-center overflow-hidden shrink-0 ${shape === 'round' ? 'rounded-full' : 'rounded-xl'}`}>
          {value
            ? <img src={value} alt={`Current ${label.toLowerCase()}`} className="w-full h-full object-contain" />
            : <span className="text-xs text-text-muted">None</span>}
        </div>
        <div className="space-y-2">
          <input ref={input} id={id} type="file" accept={ACCEPT.join(',')} className="sr-only" disabled={disabled || busy}
            aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`} onChange={e => choose(e.target.files?.[0])} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="secondary" icon={<Upload className="w-3.5 h-3.5" />} disabled={disabled || busy}
              onClick={() => input.current?.click()}>
              {busy ? 'Working…' : value ? 'Replace' : 'Upload'}
            </Button>
            {value && (
              <Button type="button" size="sm" variant="ghost" icon={<Trash2 className="w-3.5 h-3.5" />} disabled={disabled || busy} onClick={clear}>
                Remove
              </Button>
            )}
          </div>
          <p id={`${id}-hint`} className="text-xs text-text-muted">PNG, JPEG or WebP, up to 2 MB and 4096 × 4096 pixels.</p>
          {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
        </div>
      </div>
    </div>
  );
}
