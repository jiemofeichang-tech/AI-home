'use client';

import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { ArrowLeft, ArrowRight, Grip, X } from 'lucide-react';
import styles from './image-order-editor.module.css';

type DraftImage = { id: string; url: string; filename?: string };
type Drag = { id: string; pointerId: number; startX: number; startY: number; x: number; y: number; moved: boolean; targetId: string | null };

export function ImageOrderEditor({ images, disabled, onMove, onRemove }: {
  images: DraftImage[];
  disabled: boolean;
  onMove: (sourceId: string, targetId: string) => void;
  onRemove: (id: string) => void;
}) {
  const instructionsId = useId();
  const list = useRef<HTMLOListElement>(null);
  const drag = useRef<Drag | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  function resetDrag() {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    drag.current = null;
    setDraggingId(null);
    setTargetId(null);
  }
  useEffect(() => { if (disabled) resetDrag(); }, [disabled]);
  useEffect(() => () => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    drag.current = null;
  }, []);

  function move(sourceId: string, destinationId: string) {
    if (disabled || sourceId === destinationId) return;
    const from = images.findIndex(image => image.id === sourceId);
    const to = images.findIndex(image => image.id === destinationId);
    if (from < 0 || to < 0) return;
    onMove(sourceId, destinationId);
    setAnnouncement(`已将第 ${from + 1} 张图片移到第 ${to + 1} 位。`);
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (disabled || images.length < 2 || event.button !== 0 || drag.current) return;
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false, targetId: null };
  }

  function locateTarget(current: Drag) {
    const hit = document.elementFromPoint(current.x, current.y)?.closest<HTMLElement>('[data-image-order-id]');
    current.targetId = hit && list.current?.contains(hit) ? hit.dataset.imageOrderId || null : null;
    setTargetId(current.targetId);
  }

  function scrollDuringDrag() {
    const current = drag.current;
    if (!current?.moved) { scrollFrame.current = null; return; }
    const dialog = list.current?.closest('dialog');
    if (dialog) {
      const bounds = dialog.getBoundingClientRect();
      if (current.x >= bounds.left && current.x <= bounds.right) {
        const edge = 40;
        const distance = current.y < bounds.top + edge ? current.y - bounds.top - edge : current.y > bounds.bottom - edge ? current.y - bounds.bottom + edge : 0;
        if (distance) {
          const previous = dialog.scrollTop;
          dialog.scrollTop += Math.max(-12, Math.min(12, distance / 3));
          if (dialog.scrollTop !== previous) locateTarget(current);
        }
      }
    }
    scrollFrame.current = requestAnimationFrame(scrollDuringDrag);
  }

  function updateDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || disabled) return;
    current.x = event.clientX; current.y = event.clientY;
    if (!current.moved && Math.hypot(current.x - current.startX, current.y - current.startY) < 6) return;
    current.moved = true;
    locateTarget(current);
    setDraggingId(current.id);
    if (scrollFrame.current === null) scrollFrame.current = requestAnimationFrame(scrollDuringDrag);
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.moved && current.targetId) move(current.id, current.targetId);
    resetDrag();
  }

  return <section className={styles.editor} aria-label="图片顺序">
    <div className={styles.heading}><strong>图片顺序 · {images.length}/9</strong><span>按下方顺序展示</span></div>
    <p id={instructionsId} className={styles.help}>拖动图片调整顺序，也可用左右按钮或键盘方向键移动。</p>
    <ol ref={list} className={styles.list}>
      {images.map((image, index) => <li key={image.id} data-image-order-id={image.id}
        className={`${styles.item} ${draggingId === image.id ? styles.dragging : ''} ${draggingId && targetId === image.id && targetId !== draggingId ? styles.target : ''}`}>
        <button type="button" className={styles.thumbnail} disabled={disabled}
          aria-label={`第 ${index + 1} 张图片，拖动调整顺序`} aria-describedby={instructionsId}
          onPointerDown={event => startDrag(event, image.id)} onPointerMove={updateDrag}
          onPointerUp={finishDrag} onPointerCancel={resetDrag} onLostPointerCapture={resetDrag}
          onKeyDown={event => {
            const offset = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : 0;
            if (offset) { event.preventDefault(); const destination = images[index + offset]; if (destination) move(image.id, destination.id); }
            if (event.key === 'Escape') resetDrag();
          }}>
          <img src={image.url} alt={image.filename || `待发布图片 ${index + 1}`} draggable={false}/>
          <span className={styles.badge} aria-hidden="true">{index + 1}</span>
          <span className={styles.grip} aria-hidden="true"><Grip size={14}/></span>
        </button>
        <button type="button" className={styles.remove} aria-label={`移除第 ${index + 1} 张图片`} disabled={disabled}
          onClick={() => { onRemove(image.id); setAnnouncement(`已移除第 ${index + 1} 张图片。`); }}><X size={14}/></button>
        <div className={styles.moves}>
          <button type="button" aria-label={`第 ${index + 1} 张图片前移`} disabled={disabled || index === 0} onClick={() => move(image.id, images[index - 1].id)}><ArrowLeft size={15}/><span>前移</span></button>
          <button type="button" aria-label={`第 ${index + 1} 张图片后移`} disabled={disabled || index === images.length - 1} onClick={() => move(image.id, images[index + 1].id)}><span>后移</span><ArrowRight size={15}/></button>
        </div>
      </li>)}
    </ol>
    <span className={styles.srOnly} role="status" aria-live="polite">{announcement}</span>
  </section>;
}
