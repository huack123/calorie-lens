-- Calorie Lens schema. Run this once in the Supabase SQL editor.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  calorie_goal integer not null default 2000 check (calorie_goal between 500 and 10000),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Profiles are viewable by owner" on public.profiles;
create policy "Profiles are viewable by owner"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "Users can insert their own profile" on public.profiles;
create policy "Users can insert their own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

create table if not exists public.meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  portion text,
  calories integer not null check (calories >= 0),
  protein_g numeric(6, 1) not null default 0 check (protein_g >= 0),
  carbs_g numeric(6, 1) not null default 0 check (carbs_g >= 0),
  fat_g numeric(6, 1) not null default 0 check (fat_g >= 0),
  eaten_on date not null default current_date,
  created_at timestamptz not null default now()
);

create index if not exists meals_user_date_idx on public.meals (user_id, eaten_on);

alter table public.meals enable row level security;

drop policy if exists "Meals are viewable by owner" on public.meals;
create policy "Meals are viewable by owner"
  on public.meals for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own meals" on public.meals;
create policy "Users can insert their own meals"
  on public.meals for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own meals" on public.meals;
create policy "Users can delete their own meals"
  on public.meals for delete
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, delete on public.meals to authenticated;
