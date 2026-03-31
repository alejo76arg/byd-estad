// BYD Stats - useDatabase Hook
// MODIFICADO: Agrega persistencia automática de EC_Database.db en IndexedDB
// La primera vez el usuario elige el archivo → se guarda en IndexedDB
// Las siguientes veces la app lo carga automáticamente sin pedir nada
// El usuario puede tocar "Actualizar DB" para reemplazarla con un archivo nuevo

import { useState, useCallback, useEffect } from 'react';
import { logger } from '@core/logger';
import { toast } from 'react-hot-toast';
import { Trip } from '@/types';

declare global {
    interface Window {
        SQL?: any;
        initSqlJs?: (config: any) => Promise<any>;
    }
}

// ─────────────────────────────────────────────────────────────
// Helpers para persistir la DB en IndexedDB del navegador/WebView
// ─────────────────────────────────────────────────────────────
const IDB_NAME = 'byd-stats-db-cache';
const IDB_STORE = 'ec_database';
const IDB_KEY = 'cached_db';
const IDB_META_KEY = 'cached_db_meta';

function openCacheDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(IDB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function saveDbToCache(buffer: ArrayBuffer, fileName: string): Promise<void> {
    const idb = await openCacheDB();
    await new Promise<void>((resolve, reject) => {
        const tx = idb.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(buffer, IDB_KEY);
        tx.objectStore(IDB_STORE).put(
            { fileName, savedAt: new Date().toISOString() },
            IDB_META_KEY
        );
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    idb.close();
}

async function loadDbFromCache(): Promise<ArrayBuffer | null> {
    try {
        const idb = await openCacheDB();
        const result = await new Promise<ArrayBuffer | null>((resolve, reject) => {
            const tx = idb.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => reject(req.error);
        });
        idb.close();
        return result;
    } catch {
        return null;
    }
}

async function loadDbMetaFromCache(): Promise<{ fileName: string; savedAt: string } | null> {
    try {
        const idb = await openCacheDB();
        const result = await new Promise<{ fileName: string; savedAt: string } | null>((resolve, reject) => {
            const tx = idb.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(IDB_META_KEY);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => reject(req.error);
        });
        idb.close();
        return result;
    } catch {
        return null;
    }
}

async function clearDbCache(): Promise<void> {
    const idb = await openCacheDB();
    await new Promise<void>((resolve, reject) => {
        const tx = idb.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(IDB_KEY);
        tx.objectStore(IDB_STORE).delete(IDB_META_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    idb.close();
}

// ─────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────
interface CachedDbInfo {
    fileName: string;
    savedAt: string;
}

interface UseDatabaseReturn {
    sqlReady: boolean;
    loading: boolean;
    error: string | null;
    // NUEVO: estado de la DB cacheada
    cachedDbInfo: CachedDbInfo | null;
    hasCachedDb: boolean;
    initSql: () => Promise<boolean>;
    processDB: (file: File, existingTrips?: Trip[], merge?: boolean) => Promise<Trip[] | null>;
    // NUEVO: carga automática desde caché sin que el usuario elija archivo
    loadCachedDb: () => Promise<Trip[] | null>;
    // NUEVO: borra la DB guardada (el usuario tendrá que elegirla de nuevo)
    clearCachedDb: () => Promise<void>;
    exportDatabase: (trips: Trip[]) => Promise<{ success: boolean; reason?: string; message?: string }>;
    validateFile: (file: File) => boolean;
    setError: (error: string | null) => void;
}

// ─────────────────────────────────────────────────────────────
// Hook principal
// ─────────────────────────────────────────────────────────────
export function useDatabase(): UseDatabaseReturn {
    const [sqlReady, setSqlReady] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [cachedDbInfo, setCachedDbInfo] = useState<CachedDbInfo | null>(null);

    // Al montar, leer el meta para saber si hay DB guardada
    useEffect(() => {
        loadDbMetaFromCache().then(meta => {
            if (meta) setCachedDbInfo(meta);
        });
    }, []);

    // ── Inicializar SQL.js ──────────────────────────────────
    const initSql = useCallback(async () => {
        if (window.SQL) {
            setSqlReady(true);
            return true;
        }

        try {
            const baseUrl = import.meta.env.BASE_URL;
            const assetsPath = `${baseUrl}assets/sql/`;

            if (!window.initSqlJs) {
                await new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = `${assetsPath}sql-wasm.min.js`;
                    script.onload = () => resolve(true);
                    script.onerror = () => reject(new Error('Failed to load SQL.js script'));
                    document.head.appendChild(script);
                });
            }

            if (window.initSqlJs) {
                window.SQL = await window.initSqlJs({
                    locateFile: (f: string) => `${assetsPath}${f}`
                });
                setSqlReady(true);
                return true;
            }
            return false;
        } catch (e) {
            setError('Error cargando SQL.js');
            logger.error('SQL.js load error:', e);
            throw e;
        }
    }, []);

    // ── Procesar ArrayBuffer con SQL.js (lógica interna reutilizable) ──
    const processArrayBuffer = useCallback(async (buf: ArrayBuffer, existingTrips: Trip[] = [], merge: boolean = false): Promise<Trip[] | null> => {
        if (!window.SQL) {
            setError('SQL no está listo');
            return null;
        }

        const db = new window.SQL.Database(new Uint8Array(buf));
        const t = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='EnergyConsumption'");

        if (!t.length || !t[0].values.length) {
            throw new Error('Tabla EnergyConsumption no encontrada en la base de datos');
        }

        const res = db.exec("SELECT * FROM EnergyConsumption WHERE is_deleted = 0 ORDER BY date, start_timestamp");

        if (!res.length || !res[0].values.length) {
            throw new Error('Sin datos en EnergyConsumption');
        }

        const cols = res[0].columns;
        const rows = res[0].values.map((r: any[]) => {
            const o: any = {};
            cols.forEach((c: string, i: number) => { o[c] = r[i]; });
            return o as Trip;
        });

        db.close();

        if (merge && existingTrips.length) {
            const map = new Map<string, Trip>();
            existingTrips.forEach(t => map.set(`${t.date}-${t.start_timestamp}`, t));
            rows.forEach((t: Trip) => map.set(`${t.date}-${t.start_timestamp}`, t));
            return Array.from(map.values()).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        }

        return rows;
    }, []);

    // ── NUEVO: Cargar DB desde caché automáticamente ────────
    const loadCachedDb = useCallback(async (): Promise<Trip[] | null> => {
        setLoading(true);
        setError(null);

        try {
            const buf = await loadDbFromCache();
            if (!buf) {
                logger.info('No hay DB cacheada. El usuario debe seleccionar un archivo.');
                return null;
            }

            const trips = await processArrayBuffer(buf);
            const meta = await loadDbMetaFromCache();
            if (meta) setCachedDbInfo(meta);

            logger.info(`DB cargada automáticamente desde caché: ${trips?.length ?? 0} viajes`);
            return trips;
        } catch (e: any) {
            const msg = `Error cargando DB cacheada: ${e.message}`;
            toast.error(msg);
            setError(e.message);
            logger.error('loadCachedDb error:', e);
            // Si la DB cacheada está corrupta, la borramos para que el usuario elija de nuevo
            await clearDbCache();
            setCachedDbInfo(null);
            return null;
        } finally {
            setLoading(false);
        }
    }, [processArrayBuffer]);

    // ── NUEVO: Borrar DB cacheada ───────────────────────────
    const clearCachedDb = useCallback(async () => {
        await clearDbCache();
        setCachedDbInfo(null);
        toast.success('Base de datos eliminada del caché. Deberás seleccionarla de nuevo.');
    }, []);

    // ── Procesar archivo seleccionado por el usuario ────────
    const processDB = useCallback(async (file: File, existingTrips: Trip[] = [], merge: boolean = false): Promise<Trip[] | null> => {
        setLoading(true);
        setError(null);

        try {
            // ── CSV ─────────────────────────────────────────
            if (file.name.toLowerCase().endsWith('.csv')) {
                const text = await file.text();
                const lines = text.split(/\r?\n/).filter(l => l.trim());

                if (lines.length < 2) throw new Error('CSV vacío o formato incorrecto');

                const rows = lines.slice(1).map((line) => {
                    const values = line.match(/("[^"]*"|[^,]+)/g)?.map(v => v.replace(/^"|"$/g, '').trim());

                    if (!values || values.length < 4) {
                        const semiValues = line.match(/("[^"]*"|[^;]+)/g)?.map(v => v.replace(/^"|"$/g, '').trim());
                        if (semiValues && semiValues.length >= 4) return parseTripRow(semiValues);
                        return null;
                    }

                    return parseTripRow(values);
                }).filter((r): r is Trip => r !== null);

                function parseTripRow(values: string[]): Trip | null {
                    const [inicio, dur, dist, energy] = values;
                    if (!inicio) return null;

                    const dateMatch = inicio.match(/^(\d{4}-\d{2}-\d{2})\s*(\d{2}:\d{2})/);
                    if (!dateMatch) return null;

                    const dateStr = dateMatch[1];
                    const timeStr = dateMatch[2];
                    const [year, month, day] = dateStr.split('-').map(Number);
                    const [hour, minute] = timeStr.split(':').map(Number);

                    const dateObj = new Date(year, month - 1, day, hour || 0, minute || 0);
                    const timestamp = Math.floor(dateObj.getTime() / 1000);
                    const durationSeconds = (parseInt(dur) || 0) * 60;
                    const appDateStr = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
                    const appMonthStr = `${year}${String(month).padStart(2, '0')}`;

                    return {
                        trip: parseFloat(dist) || 0,
                        electricity: parseFloat(energy) || 0,
                        duration: durationSeconds,
                        date: appDateStr,
                        start_timestamp: timestamp,
                        month: appMonthStr,
                        end_timestamp: timestamp + durationSeconds
                    };
                }

                if (rows.length === 0) {
                    toast.error(`CSV leído (${lines.length} líneas) pero 0 filas válidas. Verifica el formato.`);
                    return [];
                }

                logger.info(`CSV Parsed: ${rows.length} viajes válidos.`);

                if (merge && existingTrips.length) {
                    const map = new Map<string, Trip>();
                    existingTrips.forEach(t => map.set(`${t.date}-${t.start_timestamp}`, t));
                    rows.forEach(t => map.set(`${t.date}-${t.start_timestamp}`, t));
                    return Array.from(map.values()).sort((a, b) => {
                        const dateComp = (a.date || '').localeCompare(b.date || '');
                        if (dateComp !== 0) return dateComp;
                        return (a.start_timestamp || 0) - (b.start_timestamp || 0);
                    });
                }

                return rows;
            }

            // ── SQLite (.db / .jpg workaround) ───────────────
            const buf = await file.arrayBuffer();

            // GUARDAR EN CACHÉ automáticamente para la próxima vez
            await saveDbToCache(buf, file.name);
            const meta = { fileName: file.name, savedAt: new Date().toISOString() };
            setCachedDbInfo(meta);
            logger.info(`DB guardada en caché: ${file.name}`);

            const trips = await processArrayBuffer(buf, existingTrips, merge);
            return trips;

        } catch (e: any) {
            const msg = `Error importando: ${e.message}`;
            toast.error(msg);
            setError(e.message);
            logger.error('Database/File processing error:', e);
            return null;
        } finally {
            setLoading(false);
        }
    }, [processArrayBuffer]);

    // ── Exportar DB ─────────────────────────────────────────
    const exportDatabase = useCallback(async (trips: Trip[]) => {
        if (!window.SQL || trips.length === 0) {
            return { success: false, reason: 'no_data' };
        }

        try {
            const db = new window.SQL.Database();
            db.run(`
                CREATE TABLE IF NOT EXISTS EnergyConsumption (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    trip REAL,
                    electricity REAL,
                    duration INTEGER,
                    date TEXT,
                    start_timestamp INTEGER,
                    month TEXT,
                    is_deleted INTEGER DEFAULT 0
                )
            `);

            const stmt = db.prepare(`
                INSERT INTO EnergyConsumption (trip, electricity, duration, date, start_timestamp, month, is_deleted)
                VALUES (?, ?, ?, ?, ?, ?, 0)
            `);

            trips.forEach(trip => {
                stmt.run([
                    trip.trip || 0,
                    trip.electricity || 0,
                    trip.duration || 0,
                    trip.date || '',
                    trip.start_timestamp || 0,
                    trip.month || ''
                ]);
            });
            stmt.free();

            const data = db.export();
            const blob = new Blob([data], { type: 'application/x-sqlite3' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `EC_Database_${new Date().toISOString().slice(0, 10)}.db`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            db.close();
            return { success: true };
        } catch (e: any) {
            logger.error('Error exporting database:', e);
            return { success: false, reason: 'error', message: e.message };
        }
    }, []);

    // ── Validar tipo de archivo ─────────────────────────────
    const validateFile = useCallback((file: File) => {
        const fileName = file.name.toLowerCase();
        return fileName.endsWith('.db') || fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') || fileName.endsWith('.csv');
    }, []);

    return {
        sqlReady,
        loading,
        error,
        cachedDbInfo,
        hasCachedDb: cachedDbInfo !== null,
        initSql,
        processDB,
        loadCachedDb,
        clearCachedDb,
        exportDatabase,
        validateFile,
        setError
    };
}

export default useDatabase;
