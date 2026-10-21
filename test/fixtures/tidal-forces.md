# Calculating Tidal Forces

The program prints a short calculation trace followed by an indented JSON
object containing positions, gravitational accelerations, tidal accelerations,
the predicted local water level, and the resulting force on a 1 kg test mass.

## Coordinate system and assumptions

The output vectors use an Earth-centered equatorial coordinate system in metres:

- `x` points toward the equinox direction.
- `y` is 90 degrees east in the equatorial plane.
- `z` points toward the north celestial pole.

The Earth position is heliocentric, while the Sun and Moon positions are
geocentric. The orbital formulas are compact low-precision approximations:
solar position is based on the mean longitude and mean anomaly, and lunar
position includes the largest longitude and latitude perturbations. They are
appropriate for an educational estimate, not for navigation, astronomy
ephemeris work, or geophysical prediction.

The timestamp is converted to UTC and then to Julian Day:

$$
JD = 2440587.5 + \frac{t_{UTC}}{86400}
$$

where $t_{UTC}$ is Unix time in seconds.

## Orbital positions

For the Sun, the script computes the mean longitude $L$ and mean anomaly $g$
from $d = JD - 2451545.0$:

$$
L = 280.460 + 0.9856474d
$$

$$
g = 357.528 + 0.9856003d
$$

The apparent ecliptic longitude and distance are approximated by:

$$
\lambda = L + 1.915\sin(g) + 0.020\sin(2g)
$$

$$
R_{Sun} = 1.00014 - 0.01671\cos(g) - 0.00014\cos(2g)\ \text{AU}
$$

The heliocentric Earth vector is the negative of the geocentric Sun vector.

For the Moon, the script starts with approximate mean longitude $L_0$, mean
anomaly $M_m$, solar anomaly $M_s$, and argument of latitude $F$. The main
terms are:

$$
\lambda_{Moon} \approx L_0 + 6.289\sin(M_m) + \text{largest longitude corrections}
$$

$$
\beta_{Moon} \approx 5.128\sin(F) + \text{largest latitude corrections}
$$

$$
R_{Moon} \approx 385001 - 20905\cos(M_m)\ \text{km}
$$

Ecliptic longitude, latitude, and distance are converted to Cartesian
coordinates. The mean obliquity is then used to rotate those coordinates into
the equatorial system:

$$
\begin{aligned}
x' &= x \\
y' &= y\cos(\epsilon) - z\sin(\epsilon) \\
z' &= y\sin(\epsilon) + z\cos(\epsilon)
\end{aligned}
$$

The location is represented by a unit Earth-fixed vector. Greenwich sidereal
time rotates it into the same equatorial frame as the Sun and Moon positions.
This accounts for the Earth's rotation when evaluating the body's angle above
the location.

## Gravitational forces

For a body with mass $M$ at vector position $\mathbf r$ relative to Earth, the
gravitational acceleration is:

$$
\mathbf a(\mathbf r) = GM\frac{\mathbf r}{|\mathbf r|^3}
$$

The force reported for the Sun and Moon is the force on a 1 kg test mass,
$\mathbf F = 1\,\text{kg}\,\mathbf a$, so its numerical value in newtons is
the same as the acceleration in m/s^2. Earth's surface gravity is also reported
using:

$$
g_E = G\frac{M_E}{R_E^2}
$$

## Tidal acceleration

Tides are caused by a difference in gravitational acceleration, not by the
whole gravitational acceleration itself. The script evaluates the maximum
near-side tide for each body. For the body's unit direction

$$
\hat{\mathbf u} = \frac{\mathbf r}{|\mathbf r|}
$$

the near-side surface point is $\mathbf s = R_E\hat{\mathbf u}$. The tidal
acceleration is:

$$
\mathbf a_{tide} = GM\left(
\frac{\mathbf r - \mathbf s}{|\mathbf r - \mathbf s|^3}
- \frac{\mathbf r}{|\mathbf r|^3}
\right)
$$

The Sun and Moon vectors are calculated independently and then added:

$$
\mathbf a_{combined} = \mathbf a_{tide,Sun} + \mathbf a_{tide,Moon}
$$

The final `tidal_force_on_1kg_N` is $1\,\text{kg}$ times the magnitude of
that vector. Because both bodies are evaluated at their own near-side points,
this is a maximum-alignment estimate rather than the tide at one specific
location on Earth's surface. A physically exact local tide would additionally
need the observer's latitude, longitude, Earth orientation, ocean response,
and a higher-accuracy ephemeris.

## Predicted water level

The JSON field `predicted_tide_level` is the astronomical equilibrium tide
relative to mean sea level. It is a signed height in metres and includes a
human-readable value such as `+0.23 m` or `-0.08 m`. It assumes the sea is an
ideal global ocean with no coastline, basin, bathymetry, weather, or current
effects. Therefore it is not a prediction of the observed water level in a
particular harbor.

For each body, the degree-2 tidal potential at the location is approximated by:

$$
V_2 = \frac{GM R_E^2}{r^3}P_2(\cos z)
$$

where $z$ is the body's zenith angle and

$$
P_2(x) = \frac{3x^2 - 1}{2}
$$

Dividing potential by mean surface gravity converts it to an equilibrium water
height:

$$
h = \frac{V_2}{g_E}
$$

The reported level is the sum of the solar and lunar contributions:

$$
h_{combined} = h_{Sun} + h_{Moon}
$$

This local level replaces the earlier maximum-alignment-only interpretation for
water level, while the vector tidal acceleration remains available in the JSON
for comparison.

## Constants

The script uses $G = 6.67430\times10^{-11}\ \text{m}^3\text{kg}^{-1}\text{s}^{-2}$,
the astronomical unit $149597870700\ \text{m}$, Earth mass
$5.9722\times10^{24}\ \text{kg}$, Sun mass $1.98847\times10^{30}\ \text{kg}$,
Moon mass $7.342\times10^{22}\ \text{kg}$, and mean Earth radius
$6371000\ \text{m}$.
