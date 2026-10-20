'use client';

import { Select } from '@/components/ui/select';

/** What a line editor needs to know about a product's units. */
export interface LineUnits {
  unit: string;
  altUnit: string | null;
  /** Base milli-units in one alternate unit. */
  altFactorMilli: number | null;
}

/**
 * A line's quantity in the base unit, for the screen's own stock warnings.
 * Display only — the server converts, exactly, and refuses what does not.
 */
export function baseMilliOf(entryMilli: number, alt: boolean, units: LineUnits): number {
  return alt && units.altFactorMilli ? Math.round((entryMilli * units.altFactorMilli) / 1000) : entryMilli;
}

export function unitLabel(alt: boolean, units: LineUnits): string {
  return alt && units.altUnit ? units.altUnit : units.unit;
}

/**
 * Base or alternate unit for one line. Only a choice when the product has an
 * alternate; otherwise just names the unit, so every editor looks the same.
 */
export function UnitPicker({
  id,
  alt,
  units,
  onChange,
  name,
  className,
}: {
  id: string;
  alt: boolean;
  units: LineUnits;
  onChange: (alt: boolean) => void;
  /** Set when the editor posts a plain form rather than JSON. */
  name?: string;
  className?: string;
}) {
  if (!units.altUnit) {
    return (
      <>
        {name && <input type="hidden" name={name} value="base" />}
        <span className={className ?? 'text-sm text-content-muted'}>{units.unit}</span>
      </>
    );
  }
  return (
    <Select
      id={id}
      name={name}
      aria-label="Unit"
      value={alt ? 'alt' : 'base'}
      onChange={(event) => onChange(event.target.value === 'alt')}
      className={
        className ??
        'h-10 w-full rounded-lg border border-line-strong bg-surface-raised px-2 text-sm text-content'
      }
    >
      <option value="base">{units.unit}</option>
      <option value="alt">
        {units.altUnit} ({formatFactor(units.altFactorMilli)} {units.unit})
      </option>
    </Select>
  );
}

function formatFactor(milli: number | null): string {
  if (milli === null) return '';
  const whole = Math.trunc(milli / 1000);
  const fraction = (milli % 1000).toString().padStart(3, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
