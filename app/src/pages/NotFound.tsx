import { Link } from 'react-router';

/**
 * In-shell "page not found". It deliberately renders inside the pathless
 * layout so navigation keeps working, and it never links across app trees:
 * the partner viewer only ever points back to `/view`, never at the writer's
 * routes (and definitely never at Settings).
 */
export default function NotFound({ partner = false }: { partner?: boolean }) {
  return (
    <div className="mx-auto max-w-xl py-10 text-center">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
        404
      </p>
      <h1 className="mt-2 text-lg font-bold text-slate-100">Page not found</h1>
      <p className="mt-1 text-sm text-slate-400">
        {partner
          ? 'This partner page does not exist. The read-only view covers Now, Calendar, Reports, and History.'
          : 'This page does not exist or may have moved.'}
      </p>
      <Link
        to={partner ? '/view' : '/'}
        className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-white px-4 text-sm font-semibold text-slate-950 transition-colors hover:bg-slate-200"
      >
        {partner ? 'Back to partner view' : 'Back to log'}
      </Link>
    </div>
  );
}
