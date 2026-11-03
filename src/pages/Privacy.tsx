import { AppLink } from '../components/AppLink';
import { Wordmark } from '../components/ui/core';
import { PRIVACY } from '../lib/config';
import { IS_LOCAL } from '../lib/mode';

export default function Privacy() {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto max-w-2xl px-5 py-10 sm:py-16">
        <AppLink to="/" aria-label="Home">
          <Wordmark />
        </AppLink>
        <h1 className="mt-10 text-2xl font-semibold tracking-tight">Privacy notice</h1>
        <div className="card mt-6 divide-y divide-line">
          {[
            ['What we collect', 'Your roll number, the name you enter, and the applications you add: company, role, stage, assessment date and notes.'],
            ['Why', PRIVACY.purpose],
            [
              'Who can see it',
              IS_LOCAL
                ? 'You can see only your own records. The single authorized placement administrator can see all students’ records, batch analytics and the Excel export. Other students cannot see your data.'
                : 'You can see only your own records. The placement administrator can see all students’ records, batch analytics and the Excel export. Placement coordinators approved by the administrator see batch totals and, only for the companies assigned to them, applicants’ roll numbers, stages and assessment dates. They never see names or notes. Other students cannot see your data.',
            ],
            ...(IS_LOCAL
              ? []
              : [
                  [
                    'Security records',
                    'To protect the data, the service records sign-ins and access to applicant lists and exports: the account, time, the IP address reported by the hosting provider, and the browser type. Only the administrator can read these records. They are kept for 180 days.',
                  ],
                ]),
            ['How long it is kept', PRIVACY.retention],
            ...(IS_LOCAL ? [['Where it is stored', 'In this offline version, only in this browser on this device. Clearing browser data deletes it.']] : []),
            ['Your choices', `You can edit or delete any application at any time. ${PRIVACY.contact}`],
          ].map(([h, b]) => (
            <section key={h} className="px-5 py-4 sm:px-6">
              <h2 className="text-sm font-semibold text-ink">{h}</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted">{b}</p>
            </section>
          ))}
        </div>
        <p className="mt-6 text-sm">
          <AppLink to="/" className="text-teal hover:underline">
            ← Back
          </AppLink>
        </p>
      </div>
    </div>
  );
}
