-- Zyra's context builders (knowledgeSnapshot / zyraChatProjectSnapshot) only ever read
-- knowledge_documents, so anything a team stored as an uploaded file (spec PDFs, CSV test
-- data, screenshots) was invisible to Zyra. This column lets the upload path cache
-- best-effort extracted text for text-based files so it can be surfaced the same way.

ALTER TABLE knowledge_files
  ADD COLUMN extracted_text TEXT;
