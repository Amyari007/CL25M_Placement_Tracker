import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ROUTER_MODE } from '../lib/routerMode';

type Common = { to: string; className?: string; children: ReactNode; onClick?: () => void; role?: string; 'aria-label'?: string };

/**
 * In-app link. Inside preview panels the host intercepts <a href> clicks
 * (→ "404"), so there it renders an href-less link that navigates in memory.
 */
export function AppLink({ to, className, children, onClick, role, ...aria }: Common) {
  const navigate = useNavigate();
  if (ROUTER_MODE !== 'memory') {
    return (
      <Link to={to} className={className} onClick={onClick} role={role} {...aria}>
        {children}
      </Link>
    );
  }
  const go = (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    onClick?.();
    navigate(to);
  };
  return (
    <a
      role={role ?? 'link'}
      tabIndex={0}
      className={`cursor-pointer ${className ?? ''}`}
      onClick={go}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && go(e)}
      {...aria}
    >
      {children}
    </a>
  );
}

export function AppNavLink({
  to,
  end,
  className,
  children,
}: {
  to: string;
  end?: boolean;
  className: (s: { isActive: boolean }) => string;
  children: ReactNode;
}) {
  const loc = useLocation();
  if (ROUTER_MODE !== 'memory') {
    return (
      <NavLink to={to} end={end} className={className}>
        {children}
      </NavLink>
    );
  }
  const isActive = end ? loc.pathname === to : loc.pathname === to || loc.pathname.startsWith(to + '/');
  return (
    <AppLink to={to} className={className({ isActive })}>
      <span aria-current={isActive ? 'page' : undefined}>{children}</span>
    </AppLink>
  );
}
