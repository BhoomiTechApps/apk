package com.fieldcam.app;

import android.Manifest;
import android.content.Context;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.telephony.CellIdentityGsm;
import android.telephony.CellIdentityLte;
import android.telephony.CellIdentityNr;
import android.telephony.CellIdentityWcdma;
import android.telephony.CellInfo;
import android.telephony.CellInfoGsm;
import android.telephony.CellInfoLte;
import android.telephony.CellInfoNr;
import android.telephony.CellInfoWcdma;
import android.telephony.CellSignalStrengthGsm;
import android.telephony.CellSignalStrengthLte;
import android.telephony.CellSignalStrengthWcdma;
import android.telephony.TelephonyManager;
import android.view.WindowManager;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Reads the cell towers the phone can currently hear (serving + neighbours), with their
 * identities and signal strengths. Works fully offline: it only talks to the modem.
 *
 * JS: const { cells } = await Capacitor.Plugins.CellInfo.getCells();
 */
@CapacitorPlugin(
    name = "CellInfo",
    permissions = {
        @Permission(
            alias = "location",
            strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }
        )
    }
)
public class CellInfoPlugin extends Plugin {

    private static final int UNAVAILABLE = Integer.MAX_VALUE;
    private static final long FRESH_SCAN_TIMEOUT_MS = 4000;

    // ------------------------------------------------------------------ getCells

    @PluginMethod
    public void getCells(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationPermsCallback");
            return;
        }
        scan(call);
    }

    @PermissionCallback
    private void locationPermsCallback(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) {
            scan(call);
        } else {
            call.reject("Location permission is required to read cell towers", "PERMISSION_DENIED");
        }
    }

    @SuppressWarnings("MissingPermission")
    private void scan(final PluginCall call) {
        final TelephonyManager tm = (TelephonyManager) getContext().getSystemService(Context.TELEPHONY_SERVICE);
        if (tm == null) {
            call.reject("This device has no telephony hardware", "NO_TELEPHONY");
            return;
        }
        final boolean wantFresh = call.getBoolean("fresh", true);

        // Android 10+: ask the modem for a fresh scan; fall back to the cached list on timeout/error.
        if (wantFresh && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            final AtomicBoolean done = new AtomicBoolean(false);
            final Handler handler = new Handler(Looper.getMainLooper());
            final Runnable fallback = () -> {
                if (done.compareAndSet(false, true)) resolveWith(call, tm, safeGetAll(tm), false);
            };
            handler.postDelayed(fallback, FRESH_SCAN_TIMEOUT_MS);
            try {
                tm.requestCellInfoUpdate(getContext().getMainExecutor(), new TelephonyManager.CellInfoCallback() {
                    @Override
                    public void onCellInfo(@NonNull List<CellInfo> cellInfo) {
                        if (done.compareAndSet(false, true)) {
                            handler.removeCallbacks(fallback);
                            resolveWith(call, tm, cellInfo, true);
                        }
                    }

                    @Override
                    public void onError(int errorCode, @Nullable Throwable detail) {
                        if (done.compareAndSet(false, true)) {
                            handler.removeCallbacks(fallback);
                            resolveWith(call, tm, safeGetAll(tm), false);
                        }
                    }
                });
            } catch (SecurityException e) {
                if (done.compareAndSet(false, true)) {
                    handler.removeCallbacks(fallback);
                    call.reject("Security exception reading cells: " + e.getMessage(), "PERMISSION_DENIED");
                }
            }
            return;
        }
        resolveWith(call, tm, safeGetAll(tm), false);
    }

    @SuppressWarnings("MissingPermission")
    @Nullable
    private List<CellInfo> safeGetAll(TelephonyManager tm) {
        try {
            return tm.getAllCellInfo();
        } catch (SecurityException e) {
            return null;
        }
    }

    private void resolveWith(PluginCall call, TelephonyManager tm, @Nullable List<CellInfo> list, boolean fresh) {
        JSArray cells = new JSArray();
        if (list != null) {
            long nowNanos = SystemClock.elapsedRealtimeNanos();
            for (CellInfo ci : list) {
                JSObject o = toJson(ci);
                if (o == null) continue;
                o.put("registered", ci.isRegistered());
                o.put("ageMs", Math.max(0, (nowNanos - ci.getTimeStamp()) / 1_000_000L));
                cells.put(o);
            }
        }
        JSObject ret = new JSObject();
        ret.put("cells", cells);
        ret.put("fresh", fresh);
        ret.put("timestamp", System.currentTimeMillis());
        ret.put("locationEnabled", isLocationEnabled());
        ret.put("simState", tm.getSimState());
        ret.put("networkOperator", tm.getNetworkOperator());   // "MCCMNC" of the registered network
        call.resolve(ret);
    }

    /** Converts one CellInfo into a plain object. Unknown/unsupported radio types return null. */
    @SuppressWarnings("deprecation")
    @Nullable
    private JSObject toJson(CellInfo ci) {
        JSObject o = new JSObject();
        if (ci instanceof CellInfoLte) {
            CellIdentityLte id = ((CellInfoLte) ci).getCellIdentity();
            CellSignalStrengthLte ss = ((CellInfoLte) ci).getCellSignalStrength();
            o.put("type", "lte");
            putMccMnc(o, Build.VERSION.SDK_INT >= 28 ? id.getMccString() : null, Build.VERSION.SDK_INT >= 28 ? id.getMncString() : null, id.getMcc(), id.getMnc());
            putInt(o, "area", id.getTac());
            putInt(o, "cid", id.getCi());
            putInt(o, "pci", id.getPci());
            putInt(o, "arfcn", id.getEarfcn());
            putInt(o, "dbm", ss.getDbm());
            putInt(o, "ta", ss.getTimingAdvance());
            return o;
        }
        if (ci instanceof CellInfoGsm) {
            CellIdentityGsm id = ((CellInfoGsm) ci).getCellIdentity();
            CellSignalStrengthGsm ss = ((CellInfoGsm) ci).getCellSignalStrength();
            o.put("type", "gsm");
            putMccMnc(o, Build.VERSION.SDK_INT >= 28 ? id.getMccString() : null, Build.VERSION.SDK_INT >= 28 ? id.getMncString() : null, id.getMcc(), id.getMnc());
            putInt(o, "area", id.getLac());
            putInt(o, "cid", id.getCid());
            putInt(o, "arfcn", id.getArfcn());
            putInt(o, "dbm", ss.getDbm());
            if (Build.VERSION.SDK_INT >= 26) putInt(o, "ta", ss.getTimingAdvance());
            return o;
        }
        if (ci instanceof CellInfoWcdma) {
            CellIdentityWcdma id = ((CellInfoWcdma) ci).getCellIdentity();
            CellSignalStrengthWcdma ss = ((CellInfoWcdma) ci).getCellSignalStrength();
            o.put("type", "wcdma");
            putMccMnc(o, Build.VERSION.SDK_INT >= 28 ? id.getMccString() : null, Build.VERSION.SDK_INT >= 28 ? id.getMncString() : null, id.getMcc(), id.getMnc());
            putInt(o, "area", id.getLac());
            putInt(o, "cid", id.getCid());
            putInt(o, "psc", id.getPsc());
            putInt(o, "arfcn", id.getUarfcn());
            putInt(o, "dbm", ss.getDbm());
            return o;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && ci instanceof CellInfoNr) {
            CellInfoNr nr = (CellInfoNr) ci;
            CellIdentityNr id = (CellIdentityNr) nr.getCellIdentity();
            o.put("type", "nr");
            putMccMnc(o, id.getMccString(), id.getMncString(), UNAVAILABLE, UNAVAILABLE);
            putInt(o, "area", id.getTac());
            long nci = id.getNci();
            if (nci != Long.MAX_VALUE) o.put("cid", nci);
            putInt(o, "pci", id.getPci());
            putInt(o, "arfcn", id.getNrarfcn());
            putInt(o, "dbm", nr.getCellSignalStrength().getDbm());
            return o;
        }
        return null;
    }

    private static void putMccMnc(JSObject o, @Nullable String mccStr, @Nullable String mncStr, int mcc, int mnc) {
        Integer m = parse(mccStr);
        Integer n = parse(mncStr);
        if (m == null && mcc != UNAVAILABLE && mcc > 0) m = mcc;
        if (n == null && mnc != UNAVAILABLE && mnc >= 0) n = mnc;
        if (m != null) o.put("mcc", m);
        if (n != null) o.put("mnc", n);
    }

    @Nullable
    private static Integer parse(@Nullable String s) {
        if (s == null || s.isEmpty()) return null;
        try { return Integer.parseInt(s); } catch (NumberFormatException e) { return null; }
    }

    private static void putInt(JSObject o, String key, int v) {
        if (v != UNAVAILABLE && v != -1) o.put(key, v);
    }

    private boolean isLocationEnabled() {
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) return false;
        if (Build.VERSION.SDK_INT >= 28) return lm.isLocationEnabled();
        return lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }

    // ------------------------------------------------------------------ keepAwake

    /** Keeps the screen on while recording (the WebView has no Screen Wake Lock API). */
    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean on = call.getBoolean("on", true);
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }
}
