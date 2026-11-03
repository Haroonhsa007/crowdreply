'use client';
import type { KeyboardEvent, ReactNode } from 'react';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const groups = [
  {
    label: 'Workspace',
    links: [
      ['/', 'Overview'],
      ['/executions', 'Answers'],
      ['/visibility', 'Brand visibility'],
    ],
  },
  {
    label: 'Configuration',
    links: [
      ['/providers', 'Providers'],
      ['/settings/keys', 'Provider keys'],
    ],
  },
] as const;

export function Navigation({
  header,
  footer,
}: {
  header?: ReactNode;
  footer?: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeMenu = () => {
    setOpen(false);
    const button = menuButton.current;
    if (button && window.getComputedStyle(button).display !== 'none') {
      button.focus();
    }
  };
  const handleEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeMenu();
    }
  };
  const selectRoute = (href: string) => {
    if (open && pathname === href) closeMenu();
    else setOpen(false);
  };
  const isActive = (href: string) =>
    href === '/'
      ? pathname === '/'
      : pathname === href ||
        (pathname.startsWith(`${href}/`) && pathname !== '/executions/new');

  return (
    <>
      <div className="sidebar-header">
        <div className="sidebar-identity">{header}</div>
        <button
          ref={menuButton}
          className="mobile-menu-toggle"
          type="button"
          aria-expanded={open}
          aria-controls="workspace-navigation"
          onClick={() => setOpen((value) => !value)}
          onKeyDown={handleEscape}
        >
          {open ? 'Close menu' : 'Menu'}
        </button>
      </div>
      <div
        id="workspace-navigation"
        className="sidebar-navigation"
        data-open={open}
        onKeyDown={handleEscape}
      >
        <nav aria-label="Main navigation">
          <Link
            className="nav-submit"
            href="/executions/new"
            aria-current={pathname === '/executions/new' ? 'page' : undefined}
            onClick={() => selectRoute('/executions/new')}
          >
            <span aria-hidden="true">+</span> Ask a question
          </Link>
          {groups.map((group) => (
            <div className="nav-group" key={group.label}>
              <p className="nav-group-label">{group.label}</p>
              <div className="nav-links">
                {group.links.map(([href, label]) => (
                  <Link
                    key={href}
                    href={href}
                    aria-current={isActive(href) ? 'page' : undefined}
                    onClick={() => selectRoute(href)}
                  >
                    {label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>
        {footer}
      </div>
    </>
  );
}
