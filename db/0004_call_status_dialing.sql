-- Add 'dialing' to call_status so the UI can distinguish "originate accepted,
-- waiting for carrier" from "carrier signalled 180/183 ringing".
alter type public.call_status add value if not exists 'dialing' before 'ringing';
