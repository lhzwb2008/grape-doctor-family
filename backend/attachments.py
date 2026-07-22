"""临时附件解析：仅内存处理，不落盘。"""

from __future__ import annotations

import io

from pypdf import PdfReader


MAX_TEXT_CHARS = 60000


def _clip(text: str) -> str:
    text = (text or "").strip()
    if len(text) > MAX_TEXT_CHARS:
        return text[:MAX_TEXT_CHARS] + "\n…(内容过长已截断)"
    return text


def extract_pdf_text(raw: bytes) -> str:
    reader = PdfReader(io.BytesIO(raw))
    parts: list[str] = []
    for i, page in enumerate(reader.pages, start=1):
        try:
            t = page.extract_text() or ""
        except Exception:  # noqa: BLE001
            t = ""
        if t.strip():
            parts.append(f"--- 第 {i} 页 ---\n{t.strip()}")
    text = _clip("\n\n".join(parts))
    if not text:
        raise ValueError("未能从 PDF 提取到文字（可能是扫描件/图片版，请改传图片或粘贴文字）")
    return text


def extract_docx_text(raw: bytes) -> str:
    from docx import Document

    doc = Document(io.BytesIO(raw))
    parts = [p.text.strip() for p in doc.paragraphs if p.text and p.text.strip()]
    for table in doc.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text and c.text.strip()]
            if cells:
                parts.append(" | ".join(cells))
    text = _clip("\n".join(parts))
    if not text:
        raise ValueError("未能从 Word 文档提取到文字")
    return text


def is_pdf(name: str, mime: str) -> bool:
    n = name.lower()
    return mime in {"application/pdf", "application/x-pdf"} or n.endswith(".pdf")


def is_docx(name: str, mime: str) -> bool:
    n = name.lower()
    return (
        mime == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        or n.endswith(".docx")
    )


def is_legacy_doc(name: str, mime: str) -> bool:
    n = name.lower()
    return mime == "application/msword" or n.endswith(".doc")

