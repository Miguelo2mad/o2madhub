-- Índice para búsquedas y agregaciones por service_category.
-- La columna ya existe en fd_invoice_lines (migration 032).
create index if not exists idx_fd_lines_category on fd_invoice_lines(service_category);
