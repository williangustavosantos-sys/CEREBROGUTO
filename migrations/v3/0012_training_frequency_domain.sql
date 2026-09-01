DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM guto_v3.user_profile
     WHERE weekly_frequency IS NOT NULL
       AND weekly_frequency NOT BETWEEN 2 AND 6
  ) OR EXISTS (
    SELECT 1
      FROM guto_v3.confirmed_user_contexts
     WHERE weekly_frequency NOT BETWEEN 2 AND 6
  ) THEN
    RAISE EXCEPTION 'GUTO V3 has an official training frequency outside the supported domain 2..6';
  END IF;
END
$$;

ALTER TABLE guto_v3.user_profile
  DROP CONSTRAINT IF EXISTS user_profile_weekly_frequency_check,
  ADD CONSTRAINT user_profile_weekly_frequency_check
    CHECK (weekly_frequency IS NULL OR weekly_frequency BETWEEN 2 AND 6);

ALTER TABLE guto_v3.confirmed_user_contexts
  DROP CONSTRAINT IF EXISTS confirmed_user_contexts_weekly_frequency_check,
  ADD CONSTRAINT confirmed_user_contexts_weekly_frequency_check
    CHECK (weekly_frequency BETWEEN 2 AND 6);
