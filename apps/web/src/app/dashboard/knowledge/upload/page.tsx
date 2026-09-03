'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { ArrowLeft, Upload, FileText, Loader2, X } from 'lucide-react'
import Link from 'next/link'
import { Button, Input, Card, CardContent, CardHeader, CardTitle } from '@ai-workforce/ui'

export default function KnowledgeUploadPage() {
  const { data: session } = useSession()
  const router = useRouter()
  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [results, setResults] = useState<Array<{ file: File; status: 'pending' | 'uploading' | 'success' | 'error'; message?: string }>>([])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newFiles = Array.from(e.target.files || [])
    setFiles(newFiles)
    setResults(newFiles.map(f => ({ file: f, status: 'pending' })))
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const newFiles = Array.from(e.dataTransfer.files)
    setFiles(newFiles)
    setResults(newFiles.map(f => ({ file: f, status: 'pending' })))
  }

  const removeFile = (index: number) => {
    setFiles(f => f.filter((_, i) => i !== index))
    setResults(r => r.filter((_, i) => i !== index))
  }

  const handleUpload = async () => {
    if (files.length === 0) return
    setUploading(true)

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      setResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'uploading' } : r))

      const formData = new FormData()
      formData.append('file', file)
      formData.append('title', file.name)

      try {
        const res = await fetch('/api/knowledge', {
          method: 'POST',
          body: formData,
        })

        if (res.ok) {
          const doc = await res.json()
          setResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'success', message: doc.id } : r))
        } else {
          const err = await res.json()
          setResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'error', message: err.error } : r))
        }
      } catch (error) {
        setResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'error', message: 'Upload failed' } : r))
      }
    }
    setUploading(false)
  }

  const clearResults = () => {
    setFiles([])
    setResults([])
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/dashboard/knowledge" className="p-2 text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">Upload Documents</h1>
          <p className="text-neutral-600 dark:text-neutral-400">Add documents to your knowledge base</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Drag & Drop or Click to Upload</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className="border-2 border-dashed border-neutral-300 dark:border-neutral-600 rounded-xl p-8 text-center"
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            <input
              type="file"
              multiple
              accept=".pdf,.doc,.docx,.txt,.md,.csv,.json"
              onChange={handleFileChange}
              className="sr-only"
              id="file-upload"
            />
            <Upload className="w-12 h-12 text-neutral-400 mx-auto mb-4" />
            <p className="text-neutral-600 dark:text-neutral-400 mb-2">Drag & drop files here, or click to browse</p>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">Supported: PDF, DOC, DOCX, TXT, MD, CSV, JSON (max 10MB each)</p>
            <Button variant="outline" onClick={() => document.getElementById('file-upload')?.click()} className="mt-4">
              Choose Files
            </Button>
          </div>

          {results.length > 0 && (
            <div className="mt-6 space-y-3">
              <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-50">Files ({results.length})</h3>
              {results.map((result, index) => (
                <div key={index} className="flex items-center gap-3 p-3 bg-neutral-50 dark:bg-neutral-800 rounded-lg">
                  <FileText className="w-5 h-5 text-primary-600" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate">{result.file.name}</p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">{(result.file.size / 1024).toFixed(1)} KB</p>
                  </div>
                  <span className={`px-2 py-1 text-xs rounded-full ${
                    result.status === 'pending' ? 'bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300' :
                    result.status === 'uploading' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' :
                    result.status === 'success' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' :
                    'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                  }`}>
                    {result.status === 'pending' ? 'Ready' :
                     result.status === 'uploading' ? <><Loader2 className="w-3 h-3 animate-spin mr-1" /> Uploading...</> :
                     result.status === 'success' ? 'Uploaded' :
                     'Error'}
                  </span>
                  {result.status === 'error' && result.message && (
                    <span className="text-xs text-red-600 dark:text-red-400 max-w-xs truncate block">{result.message}</span>
                  )}
                  <button onClick={() => removeFile(index)} className="p-1 text-neutral-400 hover:text-red-600 dark:hover:text-red-400">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
              {files.length > 0 && !uploading && (
                <div className="flex justify-end gap-3 pt-4">
                  <Button variant="outline" onClick={clearResults} disabled={uploading}>
                    <X className="w-4 h-4 mr-2" />
                    Clear All
                  </Button>
                  <Button onClick={handleUpload} isLoading={uploading} disabled={uploading || results.every(r => r.status === 'success')}>
                    <Upload className="w-4 h-4 mr-2" />
                    Upload {files.length} File{files.length > 1 ? 's' : ''}
                  </Button>
                </div>
              )}
            </div>
          )}

          {results.length > 0 && results.every(r => r.status === 'success') && (
            <div className="mt-6 p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
              <p className="text-green-700 dark:text-green-400 font-medium">All files uploaded successfully!</p>
              <Button variant="outline" className="mt-2" onClick={clearResults}>Upload More</Button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="text-center text-sm text-neutral-500 dark:text-neutral-400">
        <Link href="/dashboard/knowledge" className="text-primary-600 hover:text-primary-500">
          ← Back to Knowledge Base
        </Link>
      </div>
    </div>
  )
}