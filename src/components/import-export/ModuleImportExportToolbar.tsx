'use client'

import { useState } from 'react'
import { Upload, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { FieldDefinition } from '@/lib/import-export/types'
import { ExportButton } from './ExportButton'
import { ExportMenu } from '@/components/data-tools/export-menu'
import type { ExportColumn } from '@/lib/export/table-export'
import { ImportWizard } from './ImportWizard'

interface ModuleImportExportToolbarProps {
  moduleKey: string
  moduleLabel: string
  fields: FieldDefinition[]
  filters?: Record<string, string>
  onImportSuccess?: () => void
  /** Filtered dataset shown in the page table; exported as-is (all pages) to CSV/XLSX. */
  tableExport?: { filename: string; columns: ExportColumn<any>[]; rows: any[]; meta?: string[] } // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function ModuleImportExportToolbar({
  moduleKey,
  moduleLabel,
  fields,
  filters = {},
  onImportSuccess,
  tableExport,
}: ModuleImportExportToolbarProps) {
  const [importOpen, setImportOpen] = useState(false)
  const [importMenuOpen, setImportMenuOpen] = useState(false)

  return (
    <>
      <div className="flex items-center gap-2">
        <div className="relative">
          <Button variant="outline" onClick={() => setImportMenuOpen((open) => !open)}>
            <Upload size={15} />
            Import
            <ChevronDown size={14} />
          </Button>
          {importMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setImportMenuOpen(false)} />
              <div className="absolute right-0 mt-2 z-50 w-44 bg-white border border-slate-200 rounded-xl shadow-lg py-1">
                <button
                  className="w-full text-left px-4 py-2 text-sm hover:bg-slate-50"
                  onClick={() => {
                    setImportMenuOpen(false)
                    setImportOpen(true)
                  }}
                >
                  Import CSV
                </button>
                <button
                  className="w-full text-left px-4 py-2 text-sm hover:bg-slate-50"
                  onClick={() => {
                    setImportMenuOpen(false)
                    setImportOpen(true)
                  }}
                >
                  Import Excel
                </button>
              </div>
            </>
          )}
        </div>
        {tableExport ? (
          <>
            <ExportMenu filename={tableExport.filename} columns={tableExport.columns} rows={tableExport.rows} meta={tableExport.meta} sheetName={moduleLabel} />
            <ExportButton moduleKey={moduleKey} mode="templates" />
          </>
        ) : (
          <ExportButton moduleKey={moduleKey} filters={filters} />
        )}
      </div>

      <ImportWizard
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onSuccess={onImportSuccess}
        moduleKey={moduleKey}
        moduleLabel={moduleLabel}
        fields={fields}
      />
    </>
  )
}
