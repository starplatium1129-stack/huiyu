"""Transfer measured MuseTalk mouth motion onto a drawn portrait's own colors."""
import cv2
import numpy as np


Y, X = np.mgrid[:256, :256]
MOUTH = ((X - 128) / 74) ** 2 + ((Y - 193) / 38) ** 2 < 1
CHEEK = MOUTH & ((abs(X - 128) > 47) | (Y < 162))


def lip_region(rgb):
    # MuseTalk's aligned 256px face places the lips below the nose. Compare to
    # these same cheeks to allow warm, cool and monochrome illustrated skin.
    skin = np.median(rgb[CHEEK], axis=0)
    difference = np.linalg.norm((rgb.astype(np.float32) - skin) * [.65, 1, .65], axis=2)
    cutoff = max(20, np.percentile(difference[MOUTH], 95) * .32)
    mask = np.uint8((difference > cutoff) & MOUTH)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    x, y, w, h = cv2.boundingRect(contour)
    if not (25 <= w <= 125 and 4 <= h <= 56 and abs(x+w/2-128) < 22 and abs(y+h/2-193) < 26):
        return None
    mask.fill(0)
    cv2.drawContours(mask, [contour], -1, 1, cv2.FILLED)
    return mask, skin, x, x+w


class InkMouth:
    @classmethod
    def from_portrait(cls, reference):
        region = lip_region(reference)
        if region is None:
            return None
        mask, skin, _, _ = region
        pixels = reference[mask != 0]
        if len(pixels) < 75:
            return None
        colors = pixels[np.argsort(pixels[:, 1])]
        ink = np.median(colors[:max(1, len(colors)//10)], axis=0)
        interior = np.median(colors[round(.35*len(colors)):round(.70*len(colors))], axis=0)
        # A drawn edge must be sharper than the surrounding skin. Soft painted
        # or photographic lips retain the existing neural color and texture.
        kernel = np.ones((3, 3), np.uint8)
        outline = cv2.morphologyEx(mask, cv2.MORPH_GRADIENT, kernel) != 0
        texture = cv2.morphologyEx(reference[:, :, 1], cv2.MORPH_GRADIENT, kernel)
        contrast = skin[1] - ink[1]
        if (contrast < 65 or interior[1] - ink[1] < 30
                or np.percentile(texture[outline], 80) < max(32, .28*contrast, 2.7*np.percentile(texture[CHEEK], 75))):
            return None
        clean = cv2.inpaint(reference, cv2.dilate(mask, np.ones((7, 7), np.uint8)), 5, cv2.INPAINT_TELEA)
        return cls(clean, np.median(np.where(mask)[0]), ink, interior, skin)

    def __init__(self, clean, center_y, ink, interior, skin):
        self.clean, self.center_y, self.ink, self.interior = clean, center_y, ink, interior
        self.teeth = skin + (255 - skin) * .72
        self.geometry = self.previous = None
        self.confidence = 1.

    def apply(self, neural):
        region = lip_region(neural)
        measured = self.measure(neural, *region) if region is not None else None
        if measured is None:
            self.confidence = max(0., self.confidence - .2)
        else:
            center, opening, left, right, teeth = measured
            # At 25 fps this short causal filter damps outlines by about 12ms.
            current = (center, opening, left, right)
            if self.geometry is not None:
                current = tuple(.77 * new + .23 * old for new, old in zip(current, self.geometry))
            self.geometry = current
            self.previous = self.draw(*current, teeth)
            self.confidence = min(1., self.confidence + .25)
        if self.previous is None or self.confidence == 0:
            return neural
        if self.confidence == 1:
            return self.previous
        return cv2.addWeighted(neural, 1-self.confidence, self.previous, self.confidence, 0)

    @staticmethod
    def measure(neural, mask, skin, left, right):
        # Two pigmented lip bands flank the opening. Their relative brightness
        # reveals the actual teeth per column, including occlusion during speech.
        light = cv2.GaussianBlur(neural[:, :, 1].astype(np.float32), (3, 3), .8)
        top, bottom = np.zeros(256), np.zeros(256)
        teeth = np.zeros((256, 256), np.float32)
        for x in range(left, right):
            rows = np.flatnonzero(mask[:, x])
            if len(rows) < 3:
                continue
            first, stop = rows[0], rows[-1] + 1
            height = stop - first
            a = first + np.argmin(light[first:first+int(height*.52)+1, x])
            band = first + int(height * .60)
            b = band + np.argmin(light[band:stop, x])
            center = a + (b-a) * .3
            top[x], bottom[x] = center-1., center+1.
            if b <= a+2:
                continue
            strip = light[a:b+1, x]
            excess = strip - np.linspace(strip[0], strip[-1], len(strip))
            contrast = skin[1] - min(strip[0], strip[-1])
            threshold = max(13., contrast * .19)
            visible = np.flatnonzero(excess > threshold)
            if len(visible):
                top[x], bottom[x] = a+visible[0]-2.8, a+visible[-1]+2.
                teeth[a:b+1, x] = np.clip((excess-threshold) / (max(25, contrast)*.52), 0, 1)
        columns = np.flatnonzero(top)
        if len(columns) < 12:
            return None
        top, bottom = [cv2.GaussianBlur(np.interp(np.arange(256), columns, side[columns])[None, :],
                                      (9, 1), 1.8)[0] for side in (top, bottom)]
        center = (top + bottom) / 2
        center = .35 * center + .65 * cv2.GaussianBlur(center[None, :], (23, 1), 5)[0]
        width = right-left
        typical = np.percentile((bottom-top)[round(left+width*.2):round(right-width*.2)], 78)
        visible = np.percentile(teeth.max(axis=0)[left:right], 72)
        opening = (.78*(bottom-top) + .22*typical) * (.38 + .62*min(1, visible*1.6))
        return center, opening, left+width*.055, right-width*.055, teeth

    def draw(self, center, opening, left, right, teeth):
        across = np.clip((X-left)/(right-left), 0, 1)
        taper = (4*across*(1-across)) ** .65
        top, bottom = center-opening*taper/2, center+opening*taper/2
        row = Y + .55*np.clip(np.median(center[round(left):round(right)]) - self.center_y, -8, 8)
        alpha = np.clip(np.minimum(row-top+1, bottom-row+1), 0, 1)
        alpha *= np.clip((X-left)*.7, 0, 1) * np.clip((right-X)*.7, 0, 1)
        depth = np.clip((row-top)/np.maximum(bottom-top, 1), 0, 1)
        edge = np.clip((row-top+.3)/2.1, 0, 1) * (.6+.4*np.clip((bottom-row+.3)/1.4, 0, 1))
        edge *= np.clip(taper*2.5, 0, 1)
        teeth = cv2.remap(teeth, X.astype(np.float32), row.astype(np.float32), cv2.INTER_LINEAR)
        teeth = np.clip((teeth-.04)*1.2, 0, 1) * np.clip(1.1-(depth-.45)*2.7, 0, 1)
        art = self.ink + (self.interior - self.ink) * np.minimum(1, depth*1.2+.12)[:, :, None]
        art += (self.teeth-art) * teeth[:, :, None]
        art = self.ink + (art-self.ink) * edge[:, :, None]
        return np.uint8(np.clip(self.clean + (art-self.clean) * alpha[:, :, None], 0, 255))
