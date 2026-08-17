'use client';

import { useState } from 'react';

import type { PermissionModule } from '@/db/schema/users';
import type { ModulePermission } from '@/lib/auth/permissions';
import { Button } from '@/components/ui/button';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';

import { MODULE_ROWS } from './modules';

export { MODULE_ROWS, type ModuleRow } from './modules';

const SENSITIVE = new Set<PermissionModule>(['users', 'settings', 'accounts', 'reconciliation']);

/**
 * Who can do what.
 *
 * "See" gates everything else: without it, create/change/void are meaningless,
 * so ticking one of those ticks "See" as well. That mirrors the server rule in
 * `can()` exactly, rather than letting the form imply rights the server refuses.
 */
export function PermissionMatrix({
  initial,
  disabled = false,
}: {
  initial: Partial<Record<PermissionModule, ModulePermission>>;
  disabled?: boolean;
}) {
  const [state, setState] = useState<Partial<Record<PermissionModule, ModulePermission>>>(initial);

  function get(module: PermissionModule): ModulePermission {
    return state[module] ?? { canView: false, canCreate: false, canEdit: false, canVoid: false };
  }

  function toggle(module: PermissionModule, key: keyof ModulePermission, value: boolean) {
    setState((current) => {
      const existing = current[module] ?? {
        canView: false,
        canCreate: false,
        canEdit: false,
        canVoid: false,
      };
      const next = { ...existing, [key]: value };

      // Granting an action implies being able to see the module.
      if (value && key !== 'canView') next.canView = true;
      // Removing "see" removes everything, since the server would refuse anyway.
      if (!value && key === 'canView') {
        next.canCreate = false;
        next.canEdit = false;
        next.canVoid = false;
      }

      return { ...current, [module]: next };
    });
  }

  function applyPreset(preset: 'till' | 'manager' | 'none') {
    if (preset === 'none') {
      setState({});
      return;
    }
    if (preset === 'till') {
      setState({
        sales: { canView: true, canCreate: true, canEdit: false, canVoid: false },
        products: { canView: true, canCreate: false, canEdit: false, canVoid: false },
        inventory: { canView: true, canCreate: false, canEdit: false, canVoid: false },
        customers: { canView: true, canCreate: true, canEdit: false, canVoid: false },
      });
      return;
    }
    setState({
      sales: { canView: true, canCreate: true, canEdit: true, canVoid: true },
      purchases: { canView: true, canCreate: true, canEdit: true, canVoid: false },
      products: { canView: true, canCreate: true, canEdit: true, canVoid: false },
      inventory: { canView: true, canCreate: true, canEdit: true, canVoid: false },
      customers: { canView: true, canCreate: true, canEdit: true, canVoid: false },
      suppliers: { canView: true, canCreate: true, canEdit: true, canVoid: false },
      expenses: { canView: true, canCreate: true, canEdit: false, canVoid: false },
      income: { canView: true, canCreate: true, canEdit: false, canVoid: false },
      reports: { canView: true, canCreate: false, canEdit: false, canVoid: false },
    });
  }

  return (
    <div>
      {!disabled && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-content-muted">Start from:</span>
          <Button type="button" size="sm" variant="secondary" onClick={() => applyPreset('till')}>
            Till staff
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => applyPreset('manager')}>
            Shop manager
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => applyPreset('none')}>
            Clear all
          </Button>
        </div>
      )}

      <TableWrap>
        <THead>
          <TH>Area</TH>
          <TH>See</TH>
          <TH>Add</TH>
          <TH>Change</TH>
          <TH>Void</TH>
        </THead>
        <tbody>
          {MODULE_ROWS.map((row) => {
            const permission = get(row.module);
            return (
              <TR key={row.module}>
                <TD>
                  <span className="font-medium text-content">{row.label}</span>
                  {SENSITIVE.has(row.module) && (
                    <span className="ml-2 rounded bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-content">
                      Sensitive
                    </span>
                  )}
                  <span className="mt-0.5 block text-xs text-content-subtle">
                    {row.description}
                  </span>
                </TD>
                {(
                  [
                    ['canView', 'view'],
                    ['canCreate', 'create'],
                    ['canEdit', 'edit'],
                    ['canVoid', 'void'],
                  ] as const
                ).map(([key, suffix]) => (
                  <TD key={key}>
                    <input
                      type="checkbox"
                      name={`perm:${row.module}:${suffix}`}
                      checked={permission[key]}
                      disabled={disabled}
                      onChange={(event) => toggle(row.module, key, event.target.checked)}
                      aria-label={`${row.label}: ${suffix}`}
                      className="h-4 w-4 rounded border-line-strong disabled:opacity-50"
                    />
                  </TD>
                ))}
              </TR>
            );
          })}
        </tbody>
      </TableWrap>

      <p className="mt-3 text-xs text-content-subtle">
        &ldquo;Void&rdquo; means cancelling something already recorded, which moves money and stock.
        Give it only to people you would trust to correct the books.
      </p>
    </div>
  );
}
