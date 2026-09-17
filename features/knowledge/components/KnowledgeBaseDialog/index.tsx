'use client'

/**
 * 知识库管理弹窗（最简版）
 *
 * 只做三件事，全部对接后端真实存在的接口（见 features/knowledge/services/knowledge-api.ts）：
 *   1. 新建知识库         POST   /api/knowledge
 *   2. 删除知识库（带确认） DELETE /api/knowledge/[id]
 *   3. 上传 / 删除文档     POST|DELETE /api/knowledge/[id]/documents
 *
 * 复用项目已有 UI 组件（Dialog / AlertDialog / Button / Input / toast），不新增组件体系。
 * 上传是同步的（后端要等 embedding 全部完成才返回），所以这里只有一个"上传中"状态，
 * 不做虚假的异步进度条。
 *
 * @module features/knowledge/components/KnowledgeBaseDialog
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, Check, FileText, Loader2, Plus, Trash2, Upload } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/lib/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  KnowledgeAPI,
  type KnowledgeBaseSummary,
  type KnowledgeDocumentSummary,
} from '../../services/knowledge-api'

interface KnowledgeBaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 当前选中的知识库 ID（null = 全部知识库） */
  selectedId: string | null
  /** 选中某个知识库（id 为 null 表示"全部知识库"） */
  onSelect: (id: string | null, name?: string | null) => void
}

/** 与 server/services/rag/parse.ts 的白名单保持一致，UI 不展示未支持的格式 */
const ACCEPTED_EXTENSIONS = '.txt,.md'
const ACCEPTED_HINT = '仅支持 .txt / .md，单文件不超过 1MB'

export function KnowledgeBaseDialog({
  open,
  onOpenChange,
  selectedId,
  onSelect,
}: KnowledgeBaseDialogProps) {
  const { toast } = useToast()

  const [bases, setBases] = useState<KnowledgeBaseSummary[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [newName, setNewName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  const [documents, setDocuments] = useState<KnowledgeDocumentSummary[]>([])
  const [isLoadingDocs, setIsLoadingDocs] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const selectedBase = bases.find((b) => b.id === selectedId) || null

  /** 拉取知识库列表；顺带清理已被删除的选中项，避免把失效 ID 发给后端 */
  const refreshBases = useCallback(async () => {
    setIsLoading(true)
    try {
      const list = await KnowledgeAPI.list()
      setBases(list)
      if (selectedId && !list.some((b) => b.id === selectedId)) {
        onSelect(null, null)
      }
    } catch (error) {
      toast({
        title: '获取知识库失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }, [onSelect, selectedId, toast])

  const refreshDocuments = useCallback(async (knowledgeBaseId: string) => {
    setIsLoadingDocs(true)
    try {
      setDocuments(await KnowledgeAPI.listDocuments(knowledgeBaseId))
    } catch (error) {
      setDocuments([])
      toast({
        title: '获取文档失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    } finally {
      setIsLoadingDocs(false)
    }
  }, [toast])

  // 打开弹窗时刷新列表
  useEffect(() => {
    if (open) void refreshBases()
  }, [open, refreshBases])

  // 切换选中的知识库时刷新其文档列表
  useEffect(() => {
    if (open && selectedId) void refreshDocuments(selectedId)
    else setDocuments([])
  }, [open, selectedId, refreshDocuments])

  /** 新建知识库 */
  const handleCreate = async () => {
    const name = newName.trim()
    if (!name || isCreating) return
    setIsCreating(true)
    try {
      const created = await KnowledgeAPI.create(name)
      setNewName('')
      await refreshBases()
      // 新建后自动选中（并顺带打开总开关，见 chat.store 的 setSelectedKnowledgeBase）
      onSelect(created.id, created.name)
      toast({ title: '知识库已创建', description: created.name })
    } catch (error) {
      toast({
        title: '创建失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    } finally {
      setIsCreating(false)
    }
  }

  /** 删除知识库（确认后执行；后端级联删除文档与向量 chunk） */
  const handleDelete = async (id: string) => {
    try {
      await KnowledgeAPI.remove(id)
      if (selectedId === id) onSelect(null, null)
      await refreshBases()
      toast({ title: '知识库已删除' })
    } catch (error) {
      toast({
        title: '删除失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    } finally {
      setPendingDeleteId(null)
    }
  }

  /** 上传文档并入库（同步等待解析 + 向量化结果） */
  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // 允许重复选择同一个文件
    event.target.value = ''
    if (!file || !selectedId) return

    setUploadError(null)
    setIsUploading(true)
    try {
      const doc = await KnowledgeAPI.uploadDocument(selectedId, file)
      await refreshDocuments(selectedId)
      await refreshBases()
      toast({
        title: '文档已入库',
        description: `${doc.name} · ${doc.chunkCount} 个片段`,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      setUploadError(message)
      toast({ title: '文档入库失败', description: message, variant: 'destructive' })
    } finally {
      setIsUploading(false)
    }
  }

  /** 删除单个文档 */
  const handleDeleteDocument = async (documentId: string) => {
    if (!selectedId) return
    try {
      await KnowledgeAPI.removeDocument(selectedId, documentId)
      await refreshDocuments(selectedId)
      await refreshBases()
      toast({ title: '文档已删除' })
    } catch (error) {
      toast({
        title: '删除文档失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="h-4 w-4" />
            私有知识库
          </DialogTitle>
          <DialogDescription>
            上传的资料会被切分并向量化后存入你的私有知识库，仅在开启「私有知识库」开关时被检索。
            {ACCEPTED_HINT}。
          </DialogDescription>
        </DialogHeader>

        {/* 新建 */}
        <div className="flex items-center gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="新知识库名称"
            maxLength={100}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleCreate()
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => void handleCreate()}
            disabled={!newName.trim() || isCreating}
            className="shrink-0"
          >
            {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            新建
          </Button>
        </div>

        {/* 列表 */}
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
          <button
            type="button"
            onClick={() => onSelect(null, null)}
            className={cn(
              'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent',
              !selectedId && 'bg-accent'
            )}
          >
            <span>全部知识库</span>
            {!selectedId && <Check className="h-4 w-4" />}
          </button>

          {isLoading && bases.length === 0 && (
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              加载中...
            </div>
          )}

          {!isLoading && bases.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              还没有知识库，先在上方创建一个。
            </p>
          )}

          {bases.map((base) => (
            <div
              key={base.id}
              className={cn(
                'flex items-center justify-between rounded-md px-2 py-1.5 text-sm',
                selectedId === base.id ? 'bg-accent' : 'hover:bg-accent/50'
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(base.id, base.name)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                {selectedId === base.id ? (
                  <Check className="h-4 w-4 shrink-0" />
                ) : (
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{base.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {base.documentCount} 个文档
                </span>
              </button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => setPendingDeleteId(base.id)}
                aria-label={`删除 ${base.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>

        {/* 文档区 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">
              {selectedBase ? `文档 · ${selectedBase.name}` : '文档（请先选择一个知识库）'}
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_EXTENSIONS}
              onChange={handleUpload}
              className="hidden"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!selectedId || isUploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {isUploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {isUploading ? '上传中...' : '上传文档'}
            </Button>
          </div>

          {uploadError && (
            <p className="text-xs text-destructive">处理失败：{uploadError}</p>
          )}

          {selectedId && (
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
              {isLoadingDocs && documents.length === 0 && (
                <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  加载中...
                </div>
              )}
              {!isLoadingDocs && documents.length === 0 && (
                <p className="px-1 text-sm text-muted-foreground">
                  该知识库还没有文档。
                </p>
              )}
              {documents.map((doc) => (
                <div key={doc.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{doc.name}</span>
                  {doc.status === 'ready' ? (
                    <span className="shrink-0 text-xs text-emerald-600 dark:text-emerald-400">
                      已入库 · {doc.chunkCount} 个片段
                    </span>
                  ) : (
                    <span
                      className="shrink-0 text-xs text-destructive"
                      title={doc.error || '处理失败'}
                    >
                      处理失败
                    </span>
                  )}
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => void handleDeleteDocument(doc.id)}
                    aria-label={`删除 ${doc.name}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* 删除确认（复用项目已有 AlertDialog） */}
      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setPendingDeleteId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除知识库？</AlertDialogTitle>
            <AlertDialogDescription>
              该知识库下的所有文档与向量片段会一并删除（数据库级联删除），且无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDeleteId) void handleDelete(pendingDeleteId)
              }}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
