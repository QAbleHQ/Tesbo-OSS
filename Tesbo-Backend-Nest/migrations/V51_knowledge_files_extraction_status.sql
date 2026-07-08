-- Audio/video transcription happens out-of-band after upload (it calls an external AI
-- provider and can take a while), so knowledgeSnapshot needs a way to tell "still
-- transcribing" apart from "nothing to extract" while extracted_text is still NULL.
-- Synchronous extractors (pdf/docx/image OCR/plaintext/spreadsheet) don't use this column —
-- their result is fully known by the time the upload request returns.

ALTER TABLE knowledge_files
  ADD COLUMN extraction_status VARCHAR(16);
