-- =====================================================================
-- 宮工房 Design Award — Supabase スキーマ
-- Supabase ダッシュボード → SQL Editor に全文を貼り付けて「Run」してください。
-- 何度実行しても壊れないように書いてあります（作り直し用）。
-- =====================================================================

-- ---------- 許可するメールドメイン（旧Googleログイン版の名残。ログイン不要版では使っていない） ----------
create table if not exists public.allowed_domains (
  domain text primary key
);
alter table public.allowed_domains enable row level security;
-- ポリシーなし＝アプリからは読み書き不可（SQL Editor からのみ設定）

-- ---------- プロフィール（Google の名前・アイコン） ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  avatar_url text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- ---------- 判定用の関数 ----------
-- ログイン不要版：アプリを開いた端末ごとに匿名のIDが自動で発行される。そのIDを持っていればメンバー扱い。
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null;
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member()
     and coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

-- 新しい端末（匿名ID）が来たらプロフィールを自動作成。名前は最初の画面で本人が入力する。
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, avatar_url)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', ''), null)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 各月の回 ----------
create table if not exists public.months (
  id text primary key check (id ~ '^\d{4}-\d{2}$'),
  phase text not null default 'entry' check (phase in ('entry', 'voting', 'tallied', 'announced')),
  created_at timestamptz not null default now()
);
alter table public.months enable row level security;

-- ---------- 集計結果（管理者には集計直後から、メンバーには発表後だけ見える） ----------
create table if not exists public.month_results (
  month_id text primary key references public.months(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.month_results enable row level security;

-- ---------- エントリー ----------
create table if not exists public.entries (
  id uuid primary key default gen_random_uuid(),
  month_id text not null references public.months(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 60),
  photos jsonb not null default '[]'::jsonb,   -- [{ "path": "<uid>/<uuid>.jpg", "r": 1.5 }]
  author_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.entries enable row level security;

-- ---------- 票（匿名：誰の票かはこの表には記録しない。アプリからは誰も直接読めない） ----------
create table if not exists public.ballots (
  id uuid primary key default gen_random_uuid(),
  month_id text not null references public.months(id) on delete cascade,
  picks jsonb not null
);
alter table public.ballots enable row level security;

-- 自分の投票内容（本人だけが読める。修正のため）
create table if not exists public.my_ballots (
  user_id uuid not null references public.profiles(id) on delete cascade,
  month_id text not null references public.months(id) on delete cascade,
  ballot_id uuid not null references public.ballots(id) on delete cascade,
  picks jsonb not null,
  primary key (user_id, month_id)
);
alter table public.my_ballots enable row level security;

-- 投票済みかどうかだけ（誰がどこに入れたかは含まない）
create table if not exists public.voters (
  user_id uuid not null references public.profiles(id) on delete cascade,
  month_id text not null references public.months(id) on delete cascade,
  primary key (user_id, month_id)
);
alter table public.voters enable row level security;

-- ---------- アクセス権（RLS） ----------
drop policy if exists "profiles: members read" on public.profiles;
create policy "profiles: members read" on public.profiles
  for select to authenticated using (public.is_member());

drop policy if exists "months: members read" on public.months;
create policy "months: members read" on public.months
  for select to authenticated using (public.is_member());
drop policy if exists "months: admin write" on public.months;
create policy "months: admin write" on public.months
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "results: read when announced" on public.month_results;
create policy "results: read when announced" on public.month_results
  for select to authenticated using (
    public.is_admin()
    or (public.is_member() and exists (select 1 from public.months m where m.id = month_id and m.phase = 'announced'))
  );
drop policy if exists "results: admin write" on public.month_results;
create policy "results: admin write" on public.month_results
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "entries: members read" on public.entries;
create policy "entries: members read" on public.entries
  for select to authenticated using (public.is_member());
drop policy if exists "entries: add own during entry" on public.entries;
create policy "entries: add own during entry" on public.entries
  for insert to authenticated with check (
    public.is_member()
    and author_id = auth.uid()
    and exists (select 1 from public.months m where m.id = month_id and m.phase = 'entry')
  );
drop policy if exists "entries: delete" on public.entries;
create policy "entries: delete" on public.entries
  for delete to authenticated using (
    (author_id = auth.uid() and exists (select 1 from public.months m where m.id = month_id and m.phase = 'entry'))
    or (public.is_admin() and exists (select 1 from public.months m where m.id = month_id and m.phase in ('entry', 'voting')))
  );

drop policy if exists "my_ballots: self read" on public.my_ballots;
create policy "my_ballots: self read" on public.my_ballots
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "voters: members read" on public.voters;
create policy "voters: members read" on public.voters
  for select to authenticated using (public.is_member());

-- ballots にはポリシーを作らない＝アプリからは読み書き不可。投票と集計は下の関数だけが扱う。

-- ---------- 投票（関数経由でのみ書き込み） ----------
create or replace function public.submit_vote(p_month text, p_picks jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_phase text;
  v_need int;
  v_ballot uuid;
  v_pick jsonb;
  v_rank int;
  v_entry uuid;
  v_ranks int[] := '{}';
  v_ids uuid[] := '{}';
  v_clean jsonb := '[]'::jsonb;
begin
  if v_uid is null or not public.is_member() then
    raise exception 'この操作の権限がありません' using errcode = '42501';
  end if;
  select phase into v_phase from public.months where id = p_month;
  if v_phase is distinct from 'voting' then
    raise exception '投票は締め切られました。';
  end if;
  select least(3, count(*)) into v_need from public.entries where month_id = p_month and author_id <> v_uid;
  if v_need = 0 or jsonb_typeof(p_picks) <> 'array' or jsonb_array_length(p_picks) <> v_need then
    raise exception '選んだ件数が正しくありません。';
  end if;
  for v_pick in select value from jsonb_array_elements(p_picks) loop
    v_rank := (v_pick ->> 'rank')::int;
    v_entry := (v_pick ->> 'entryId')::uuid;
    if v_rank is null or v_rank < 1 or v_rank > v_need or v_rank = any(v_ranks) or v_entry = any(v_ids) then
      raise exception '順位の指定が正しくありません。';
    end if;
    if not exists (select 1 from public.entries e where e.id = v_entry and e.month_id = p_month and e.author_id <> v_uid) then
      raise exception '投票できない物件が含まれています。';
    end if;
    v_ranks := v_ranks || v_rank;
    v_ids := v_ids || v_entry;
    v_clean := v_clean || jsonb_build_array(jsonb_build_object(
      'rank', v_rank,
      'entryId', v_entry::text,
      'comment', left(btrim(coalesce(v_pick ->> 'comment', '')), 300)
    ));
  end loop;

  select ballot_id into v_ballot from public.my_ballots where user_id = v_uid and month_id = p_month;
  if v_ballot is null then
    insert into public.ballots (month_id, picks) values (p_month, v_clean) returning id into v_ballot;
    insert into public.my_ballots (user_id, month_id, ballot_id, picks) values (v_uid, p_month, v_ballot, v_clean);
    insert into public.voters (user_id, month_id) values (v_uid, p_month) on conflict do nothing;
  else
    update public.ballots set picks = v_clean where id = v_ballot;
    update public.my_ballots set picks = v_clean where user_id = v_uid and month_id = p_month;
  end if;
end $$;

-- 集計用：その月の票の中身だけを、順番をシャッフルして返す（管理者のみ・投票者の情報は含まない）
create or replace function public.tally_ballots(p_month text) returns setof jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'この操作の権限がありません' using errcode = '42501';
  end if;
  return query select b.picks from public.ballots b where b.month_id = p_month order by random();
end $$;

revoke all on function public.submit_vote(text, jsonb) from public, anon;
revoke all on function public.tally_ballots(text) from public, anon;
grant execute on function public.submit_vote(text, jsonb) to authenticated;
grant execute on function public.tally_ballots(text) to authenticated;

-- ---------- 名前の登録（本人だけが自分の名前を変えられる） ----------
create or replace function public.set_my_name(p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text := left(btrim(coalesce(p_name, '')), 30);
begin
  if auth.uid() is null then raise exception 'この操作の権限がありません' using errcode = '42501'; end if;
  if v_name = '' then raise exception '名前を入力してください。'; end if;
  insert into public.profiles (id, name) values (auth.uid(), v_name)
  on conflict (id) do update set name = excluded.name;
end $$;

-- ---------- 管理者パスワード ----------
-- パスワードそのものは保存せず、復元できない形（ハッシュ）だけを保存する。
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.admin_secret (
  id int primary key default 1 check (id = 1),
  hash text not null
);
alter table public.admin_secret enable row level security;
-- ポリシーなし＝アプリからは読めない

create table if not exists public.admin_login_failures (
  at timestamptz not null default now()
);
alter table public.admin_login_failures enable row level security;

-- SQL Editor からだけ実行する：select public.set_admin_password('好きなパスワード');
create or replace function public.set_admin_password(p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if char_length(coalesce(p_password, '')) < 8 then raise exception 'パスワードは8文字以上にしてください。'; end if;
  insert into public.admin_secret (id, hash) values (1, extensions.crypt(p_password, extensions.gen_salt('bf')))
  on conflict (id) do update set hash = excluded.hash;
  update public.profiles set is_admin = false where is_admin; -- 変更したら全員いったん管理者モード解除
end $$;

-- アプリから：パスワードが合えば、この端末を管理者にする
create or replace function public.admin_login(p_password text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text;
begin
  if auth.uid() is null then raise exception 'この操作の権限がありません' using errcode = '42501'; end if;
  delete from public.admin_login_failures where at < now() - interval '15 minutes';
  if (select count(*) from public.admin_login_failures) >= 10 then
    raise exception 'パスワードの失敗が続いたため、15分ほど待ってからお試しください。';
  end if;
  select hash into v_hash from public.admin_secret where id = 1;
  if v_hash is null then raise exception '管理者パスワードがまだ設定されていません。'; end if;
  if extensions.crypt(coalesce(p_password, ''), v_hash) = v_hash then
    update public.profiles set is_admin = true where id = auth.uid();
    return true;
  end if;
  insert into public.admin_login_failures default values;
  perform pg_sleep(1);
  return false;
end $$;

create or replace function public.admin_logout() returns void
language sql security definer set search_path = public as $$
  update public.profiles set is_admin = false where id = auth.uid();
$$;

revoke all on function public.set_my_name(text) from public, anon;
revoke all on function public.set_admin_password(text) from public, anon, authenticated;
revoke all on function public.admin_login(text) from public, anon;
revoke all on function public.admin_logout() from public, anon;
grant execute on function public.set_my_name(text) to authenticated;
grant execute on function public.admin_login(text) to authenticated;
grant execute on function public.admin_logout() to authenticated;

-- ---------- 写真の保存場所（非公開） ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 10485760, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = array['image/jpeg'];

drop policy if exists "photos: members read" on storage.objects;
create policy "photos: members read" on storage.objects
  for select to authenticated using (bucket_id = 'photos' and public.is_member());
drop policy if exists "photos: upload to own folder" on storage.objects;
create policy "photos: upload to own folder" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'photos' and public.is_member() and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "photos: delete own or admin" on storage.objects;
create policy "photos: delete own or admin" on storage.objects
  for delete to authenticated using (
    bucket_id = 'photos' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

-- ---------- 画面の自動更新（リアルタイム） ----------
do $$
declare t text;
begin
  foreach t in array array['months', 'month_results', 'entries', 'voters'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
