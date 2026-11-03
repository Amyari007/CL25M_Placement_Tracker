export type {
  ApplicationRow,
  StudentRow,
  Stage,
} from '../../supabase/functions/_shared/analytics.ts';

export type ApplicationDraft = {
  company_name: string;
  test_date: string;
  role: string;
  application_stage: import('../../supabase/functions/_shared/analytics.ts').Stage;
  stage_is_default: boolean;
  notes: string;
};
