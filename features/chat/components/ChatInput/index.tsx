'use client'

/**
 * Chat Input Module - 输入模块
 * 
 * 接收 conversationId prop，传递给 useChatInput hook
 * 
 * 同时作为知识库管理弹窗的容器：ChatInputUI 保持纯展示，
 * 弹窗（新建/删除/选择知识库、上传文档）在这里挂载。
 * 
 * @module modules/chat-input
 */

import { useState } from 'react'
import { useChatStore } from '@/features/chat/store/chat.store'
import { KnowledgeBaseDialog } from '@/features/knowledge/components/KnowledgeBaseDialog'
import { useChatInput } from './use-chat-input'
import { ChatInputUI } from './ChatInputUI'

interface ChatInputProps {
  conversationId: string
}

export function ChatInput({ conversationId }: ChatInputProps) {
  const selectedModel = useChatStore((s) => s.selectedModel)
  const enableThinking = useChatStore((s) => s.enableThinking)
  const enableWebSearch = useChatStore((s) => s.enableWebSearch)
  const enableKnowledgeBase = useChatStore((s) => s.enableKnowledgeBase)
  const selectedKnowledgeBaseId = useChatStore((s) => s.selectedKnowledgeBaseId)
  const selectedKnowledgeBaseName = useChatStore((s) => s.selectedKnowledgeBaseName)
  const setModel = useChatStore((s) => s.setModel)
  const toggleThinking = useChatStore((s) => s.toggleThinking)
  const toggleWebSearch = useChatStore((s) => s.toggleWebSearch)
  const toggleKnowledgeBase = useChatStore((s) => s.toggleKnowledgeBase)
  const setSelectedKnowledgeBase = useChatStore((s) => s.setSelectedKnowledgeBase)

  const [isKnowledgeDialogOpen, setKnowledgeDialogOpen] = useState(false)

  const {
    input,
    setInput,
    isSendingMessage,
    isRecording,
    isTranscribing,
    uploadedFiles,
    handleSubmit,
    handleStop,
    handleFileUpload,
    handleRemoveFile,
    startRecording,
    stopRecording,
    cancelRecording,
    handleImageGenerate,
  } = useChatInput({ conversationId })

  return (
    <>
      <ChatInputUI
        input={input}
        setInput={setInput}
        selectedModel={selectedModel}
        enableThinking={enableThinking}
        enableWebSearch={enableWebSearch}
        enableKnowledgeBase={enableKnowledgeBase}
        selectedKnowledgeBaseName={selectedKnowledgeBaseName}
        isLoading={isSendingMessage}
        isRecording={isRecording}
        isTranscribing={isTranscribing}
        uploadedFiles={uploadedFiles}
        onSubmit={handleSubmit}
        onStop={handleStop}
        _onModelChange={setModel}
        onThinkingToggle={toggleThinking}
        onWebSearchToggle={toggleWebSearch}
        onKnowledgeBaseToggle={toggleKnowledgeBase}
        onOpenKnowledgeBase={() => setKnowledgeDialogOpen(true)}
        onStartRecording={startRecording}
        onStopRecording={stopRecording}
        onCancelRecording={cancelRecording}
        onFileUpload={handleFileUpload}
        onRemoveFile={handleRemoveFile}
        onImageGenerate={handleImageGenerate}
      />

      <KnowledgeBaseDialog
        open={isKnowledgeDialogOpen}
        onOpenChange={setKnowledgeDialogOpen}
        selectedId={selectedKnowledgeBaseId}
        onSelect={setSelectedKnowledgeBase}
      />
    </>
  )
}
