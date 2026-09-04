import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

export interface ToolsMenuItem {
  label: string;
  to: string;
  /** Marks the entry the user is already looking at. */
  isCurrent?: boolean;
}

export interface ToolsMenuProps {
  items: ToolsMenuItem[];
}

/**
 * AV-012. The header's `Tools` menu.
 *
 * Hand-rolled with explicit menu semantics rather than a styled `<select>`:
 * the entries are navigation, not form values. Items are buttons that navigate
 * programmatically so `role="menuitem"` is accurate — an anchor inside a menu
 * reports as a link and breaks the expected keyboard model.
 */
export function ToolsMenu({ items }: ToolsMenuProps) {
  const menuId = useId();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((returnFocus: boolean) => {
    setIsOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  // Close on a press anywhere outside, without swallowing the press itself.
  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [isOpen]);

  const focusItem = (index: number) => {
    const buttons = containerRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!buttons || buttons.length === 0) return;
    // Wrap around, so Down from the last entry returns to the first.
    const wrapped = (index + buttons.length) % buttons.length;
    buttons[wrapped]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && isOpen) {
      event.stopPropagation();
      close(true);
      return;
    }
    if (!isOpen) return;

    const buttons = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const current = buttons.indexOf(document.activeElement as HTMLElement);

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusItem(current + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusItem(current === -1 ? buttons.length - 1 : current - 1);
    }
  };

  return (
    <div className="tools" ref={containerRef} onKeyDown={handleKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        className={isOpen ? 'tools__button is-open' : 'tools__button'}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !isOpen) {
            event.preventDefault();
            setIsOpen(true);
            // Wait for the menu to exist before moving into it.
            queueMicrotask(() => focusItem(0));
          }
        }}
      >
        Tools
        <span className="tools__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {isOpen && (
        <div className="tools__menu" id={menuId} role="menu" aria-label="Tools">
          {items.map((item) => (
            <button
              key={item.to}
              type="button"
              role="menuitem"
              className={item.isCurrent ? 'tools__item is-current' : 'tools__item'}
              aria-current={item.isCurrent ? 'page' : undefined}
              onClick={() => {
                close(false);
                navigate(item.to);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
