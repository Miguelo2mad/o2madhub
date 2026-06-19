-- o2madhub — fix obvious sociedad misclassifications between 'd' and 's' after the
-- sociedad map was corrected (s used to mean 'SalesPro'; it now means O2 Marketing and
-- Design SL, CIF B57944829). Safe to re-run.

-- 1. The 4 rows left in 's' were tool subscriptions tagged under the old 'SalesPro'
--    meaning (LinkedIn Sales Navigator, MeetGeek, Google Play). They belong to the main
--    operating entity O2DOSMAD Design & Strategy SL ('d').
update public.facturas
  set sociedad_codigo = 'd'
  where referencia in ('1-13628848850', '684135069334', 'MEE-2604-7658', 'GOO-DIC25');

-- 2. The o2marketing.es domain invoice belongs to O2 Marketing and Design SL ('s', B57944829),
--    not O2DOSMAD ('d').
update public.facturas
  set sociedad_codigo = 's'
  where referencia = '244280';
