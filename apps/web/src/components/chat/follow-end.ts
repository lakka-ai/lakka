import { useCallback, useEffect, useRef, useState } from 'react';

/*
 * The thread follows its end while a reply streams in (CH-1), but never against the person:
 *
 * - At the end, new text keeps the view there.
 * - Scrolling up stops that, and the view stays where it was put while the reply goes on.
 * - Back at the end, by scrolling or with Scroll to latest, it follows again.
 * - Sending, or opening a conversation, always goes to the end.
 *
 * Growth is watched with a ResizeObserver on the content, so text, a tool call opening or an
 * image loading all count, and the view moves before the frame is painted.
 */

/** How close to the end still counts as at it, so a pixel of rounding does not stop following. */
export const NEAR_END_PX = 48;

export function isAtEnd(
  box: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  slack = NEAR_END_PX,
): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= slack;
}

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function useFollowEnd() {
  const scroller = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  // A smooth scroll to the end passes through places that are not the end; until it arrives,
  // those do not count as the person scrolling away.
  const gliding = useRef(false);
  const [atEnd, setAtEnd] = useState(true);

  const jump = useCallback(() => {
    const box = scroller.current;
    if (box !== null) box.scrollTop = box.scrollHeight;
  }, []);

  useEffect(() => {
    const box = scroller.current;
    const inner = content.current;
    if (box === null || inner === null) return;
    const onScroll = () => {
      const here = isAtEnd(box);
      if (gliding.current && !here) return;
      gliding.current = false;
      following.current = here;
      setAtEnd(here);
    };
    // A wheel or a touch during a glide is the person taking over.
    const takeOver = () => {
      gliding.current = false;
    };
    const observer = new ResizeObserver(() => {
      if (following.current) jump();
      else setAtEnd(isAtEnd(box));
    });
    box.addEventListener('scroll', onScroll, { passive: true });
    box.addEventListener('wheel', takeOver, { passive: true });
    box.addEventListener('touchstart', takeOver, { passive: true });
    observer.observe(inner);
    return () => {
      box.removeEventListener('scroll', onScroll);
      box.removeEventListener('wheel', takeOver);
      box.removeEventListener('touchstart', takeOver);
      observer.disconnect();
    };
  }, [jump]);

  /** Goes to the end at once and follows it: after a send, or on opening a conversation. */
  const follow = useCallback(() => {
    following.current = true;
    gliding.current = false;
    setAtEnd(true);
    jump();
  }, [jump]);

  /** Scroll to latest: glides to the end, then follows it. */
  const scrollToEnd = useCallback(() => {
    const box = scroller.current;
    if (box === null) return;
    following.current = true;
    setAtEnd(true);
    if (reducedMotion()) {
      jump();
      return;
    }
    gliding.current = true;
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  }, [jump]);

  return { scroller, content, atEnd, follow, scrollToEnd };
}
