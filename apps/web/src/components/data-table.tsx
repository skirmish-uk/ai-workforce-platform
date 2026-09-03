'use client'

import { ReactNode, useState, useMemo } from 'react'
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react'
import { Button } from '@ai-workforce/ui'
import clsx from 'clsx'

export interface ColumnDef<T> {
  accessorKey: string
  header: string
  cell?: (props: { row: { original: T; getValue: (key: string) => any } }) => ReactNode
  enableSorting?: boolean
}

export interface CellProps<T> {
  row: { original: T; getValue: (key: string) => any }
}

interface DataTableProps<T> {
  columns: ColumnDef<T>[]
  data: T[]
  pagination?: {
    page: number
    pageSize: number
    total: number
    totalPages: number
    onPageChange: (page: number) => void
  }
  loading?: boolean
  emptyMessage?: string
}

export function DataTable<T extends Record<string, any>>({
  columns,
  data,
  pagination,
  loading = false,
  emptyMessage = 'No data available',
}: DataTableProps<T>) {
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null)

  const sortedData = useMemo(() => {
    if (!sortConfig) return data
    return [...data].sort((a, b) => {
      const aVal = a[sortConfig.key]
      const bVal = b[sortConfig.key]
      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1
      return 0
    })
  }, [data, sortConfig])

  const handleSort = (key: string) => {
    const column = columns.find((c) => c.accessorKey === key)
    if (!column?.enableSorting) return
    setSortConfig((prev) => ({
      key,
      direction: prev?.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex items-center gap-4 p-4 animate-pulse">
            <div className="h-10 w-10 bg-neutral-200 dark:bg-neutral-800 rounded-lg" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-48 bg-neutral-200 dark:bg-neutral-800 rounded" />
              <div className="h-3 w-64 bg-neutral-200 dark:bg-neutral-800 rounded" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (data.length === 0) {
    return (
      <div className="py-12 text-center text-neutral-500 dark:text-neutral-400">
        {emptyMessage}
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full" role="table">
        <thead>
          <tr className="border-b border-neutral-200 dark:border-neutral-800">
            {columns.map((column) => (
              <th
                key={column.accessorKey}
                className={clsx(
                  'px-4 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider',
                  column.enableSorting && 'cursor-pointer hover:text-neutral-700 dark:hover:text-neutral-200 select-none'
                )}
                onClick={() => handleSort(column.accessorKey)}
              >
                <div className="flex items-center gap-1">
                  {column.header}
                  {column.enableSorting && sortConfig?.key === column.accessorKey && (
                    <span className="flex">
                      {sortConfig.direction === 'asc' ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </span>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {sortedData.map((row, rowIndex) => (
            <tr key={row.id || rowIndex} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors">
              {columns.map((column) => (
                <td key={column.accessorKey} className="px-4 py-3 text-sm text-neutral-900 dark:text-neutral-50">
                  {column.cell ? (
                    column.cell({ row: { original: row, getValue: (k: string) => row[k] } })
                  ) : (
                    String(row[column.accessorKey] ?? '')
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {pagination && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-neutral-200 dark:border-neutral-800">
          <div className="text-sm text-neutral-500 dark:text-neutral-400">
            Showing {(pagination.page - 1) * pagination.pageSize + 1} to{' '}
            {Math.min(pagination.page * pagination.pageSize, pagination.total)} of{' '}
            {pagination.total} results
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => pagination.onPageChange(pagination.page - 1)}
              disabled={pagination.page <= 1}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => pagination.onPageChange(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}