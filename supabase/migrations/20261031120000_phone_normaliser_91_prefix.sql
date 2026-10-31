-- A 10-digit mobile that starts with 91 (e.g. 9123456789) was stored without the country code, so the same number
-- typed as +91 91234 56789 was not caught as a duplicate and not found by phone search. Only an exact 91 + 10 digits
-- counts as already prefixed now, the same rule as normalizeIndianPhone in src/lib/server/lead-query-service.ts.
-- Every other input normalises exactly as before. Same signature, so existing grants and the trigger are kept.
create or replace function public.extract_meta_lead_contact_fields(p_fields jsonb)
returns table(lead_name text, lead_email text, lead_phone text, lead_phone_normalized text)
language sql immutable set search_path = '' as $$
  with values_by_name as (
    select value->>'name' as key, nullif(btrim((value->'values'->>0)), '') as value
    from jsonb_array_elements(p_fields) value
  ), contact as (
    select max(value) filter (where key = 'full_name') as full_name,
      max(value) filter (where key = 'first_name') as first_name,
      max(value) filter (where key = 'last_name') as last_name,
      max(value) filter (where key = 'email') as email,
      max(value) filter (where key = 'phone_number') as phone from values_by_name
  ) select coalesce(full_name, nullif(btrim(concat_ws(' ', first_name, last_name)), '')), email, phone,
    case when phone is null then null
      when regexp_replace(phone, '[^0-9]', '', 'g') ~ '^91[0-9]{10}$' then regexp_replace(phone, '[^0-9]', '', 'g')
      when regexp_replace(phone, '[^0-9]', '', 'g') like '0__________' then '91' || substr(regexp_replace(phone, '[^0-9]', '', 'g'), 2)
      when length(regexp_replace(phone, '[^0-9]', '', 'g')) = 10 then '91' || regexp_replace(phone, '[^0-9]', '', 'g')
      else regexp_replace(phone, '[^0-9]', '', 'g') end from contact;
$$;

-- Leads stored the old way: the only 10-digit values starting with 91 came from the old rule, so they get the code.
update public.lead_data set lead_phone_normalized = '91' || lead_phone_normalized
where lead_phone_normalized ~ '^91[0-9]{8}$';
