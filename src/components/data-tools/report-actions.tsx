'use client'

import { Button } from '@/components/ui/button'
import { ExportMenu } from './export-menu'
import type { ExportColumn } from '@/lib/export/table-export'

interface ReportActionsProps<T> {
  loading: boolean
  /** Runs the report with the filter values currently entered. */
  onApply: () => void
  /** Restores default filter values and clears the shown report. */
  onClear: () => void
  applyLabel?: string
  /** Rows of the report currently on screen; export is disabled until a report has been generated. */
  exportRows: T[] | (() => Promise<T[]>) | null
  exportColumns: ExportColumn<T>[]
  filename: string
  sheetName: string
  /** Lines (title, period, filters) written above the table in XLSX. */
  meta: string[]
}

/** Apply Filters / Clear Filters / Export controls shared by the report pages. */
export function ReportActions<T>({ loading, onApply, onClear, applyLabel = 'Apply Filters', exportRows, exportColumns, filename, sheetName, meta }: ReportActionsProps<T>) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button onClick={onApply} loading={loading}>{loading ? 'Loading...' : applyLabel}</Button>
      <Button variant="outline" onClick={onClear} disabled={loading}>Clear Filters</Button>
      <ExportMenu
        filename={filename}
        sheetName={sheetName}
        columns={exportColumns}
        rows={exportRows ?? []}
        meta={meta}
        disabled={!exportRows || (Array.isArray(exportRows) && exportRows.length === 0)}
      />
    </div>
  )
}
