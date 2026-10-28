#!/usr/bin/env python3
"""
Génère l'avatar « Claire » (public/avatars/claire.vrm) à partir du modèle d'exemple de pixiv
(public/avatars/default.vrm, licence VRM 1.0 : modification et redistribution autorisées,
usage commercial autorisé).

Claire : femme d'une trentaine d'années, environ 1,70 m, cheveux blonds, yeux bleu-gris, t-shirt noir
à manches courtes avec le logo du Hackathon 2026 sur la poitrine, pantalon noir.

- cheveux et sourcils recolorés en blond (le relief des mèches est conservé) ;
- t-shirt : le t-shirt d'origine devient noir (plis conservés, texture doublée pour un logo net), bras
  nus ; logo du hackathon (scripts/assets/hackathon-logo.jpg) projeté sur le maillage au milieu de la
  poitrine : son fond noir se confond avec le tissu, seules les formes colorées ressortent ;
- pantalon d'un seul tenant : le short est retiré, jambes et bassin sont habillés (texture peinte
  d'après les os, volume du tissu en coupe droite) ;
- silhouette adulte : jambes, buste et bras allongés, tête un peu plus petite, yeux moins grands ;
  le squelette, les matrices de liaison, les ressorts des cheveux et le regard suivent.

Usage : python3 scripts/build-claire.py   (nécessite Python 3, numpy et Pillow)
"""
import io
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image

from vroid_kit import *  # noqa: F401,F403
from vroid_kit import ROOT, SRC

OUT = ROOT / 'public' / 'avatars' / 'claire.vrm'

LOGO = ROOT / 'scripts' / 'assets' / 'hackathon-logo.jpg'
LOGO_WIDTH = 0.15  # largeur du logo sur la poitrine, en mètres


def logo_rgba(px=1024):
    """Logo du hackathon agrandi ; le noir du fond devient transparent (le t-shirt est noir), avec un
    fondu pour que les bords des formes restent nets sans liseré."""
    img = Image.open(LOGO).convert('RGB')
    img = img.resize((px, round(px * img.height / img.width)), Image.LANCZOS)
    a = np.asarray(img, np.float32)
    alpha = np.clip((a.max(-1) - 28) / 36, 0, 1) * 255
    return np.concatenate([a, alpha[..., None]], -1)


# --------------------------------------------------------------------------- build


def main():
    glb = Glb(SRC)
    j = glb.json
    hb = {k: v['node'] for k, v in j['extensions']['VRMC_vrm']['humanoid']['humanBones'].items()}
    wp = world_positions(j)

    # --- cheveux et sourcils blonds
    for name in ('Hair_00', 'HairBack_00'):
        i, img = glb.image(name)
        glb.set_image(i, blonde(img))
    i, img = glb.image('FaceBrow_00')
    a = np.asarray(img, np.float32)
    dark = luminance(img) < 0.7  # le sourcil (le fond est clair)
    brow = np.array([150, 112, 70], np.float32)
    a[dark] = a[dark] * 0.35 + brow * 0.65
    glb.set_image(i, Image.fromarray(a.astype(np.uint8)))
    i, img = glb.image('EyeIris_00')
    glb.set_image(i, eyes_blue(img))
    for m in j['materials']:
        if m['name'].endswith('_HAIR'):
            mt = m['extensions']['VRMC_materials_mtoon']
            mt['shadeColorFactor'] = [0.86, 0.74, 0.62]  # ombre chaude pour donner du volume
            mt['outlineColorFactor'] = [0.18, 0.11, 0.05]
        if m['name'] == 'FaceBrow_00_FACE':
            pass

    # --- t-shirt noir à manches courtes, logo du hackathon sur la poitrine
    i_top, top = glb.image('Tops_01')
    top = black_fabric(top, dark=(16, 16, 19), light=(46, 46, 53)).resize((top.width * 2, top.height * 2), Image.LANCZOS)
    tops = primitive(glb, 'Body', 'Tops_01_CLOTH')
    tp = tops['pos']
    front = tp[:, 2] > 0
    neck_front = tp[front & (np.abs(tp[:, 0]) < 0.012), 1].max()  # bas de l'encolure, devant
    hem_y = tp[:, 1].min()
    logo = logo_rgba()
    h = LOGO_WIDTH * logo.shape[0] / logo.shape[1]
    top = project_decal(top, tops, 0.0, neck_front - 0.03 - h / 2, LOGO_WIDTH, h, logo, n=32, soft=0.8)
    glb.set_image(i_top, top)
    for m in j['materials']:
        if m['name'] == 'Tops_01_CLOTH':
            mt = m['extensions']['VRMC_materials_mtoon']
            mt['shadeColorFactor'] = [0.62, 0.62, 0.68]
            mt['parametricRimColorFactor'] = [0.16, 0.16, 0.19]  # liseré de lumière : le noir garde du relief
            mt['parametricRimFresnelPowerFactor'] = 3.5
            mt['parametricRimLiftFactor'] = 0.0
            mt['outlineColorFactor'] = [0.02, 0.02, 0.025]

    # --- plus de short : un seul pantalon, de la taille aux chevilles
    remove_primitive(glb, 'Body', 'Bottoms_01_CLOTH')

    # --- peau habillée : pantalon (jambes et bassin) ; bras nus
    dress_body(glb, wp, hb, tp, hem_y, legs=(30, 30, 35), legs_shade=(17, 17, 20))

    # --- visage plus adulte : yeux un peu moins grands, surtout en hauteur
    mature_eyes(glb, sx=0.9, sy=0.84)

    # --- silhouette adulte : jambes et buste plus longs, tête plus petite, plus grande
    reshape_body(glb, wp, hb, legs=1.12, torso=1.05, arms=1.07, head=0.9, overall=1.04)

    # --- métadonnées et vignette (portrait rendu dans l'application : scripts/assets/claire-thumbnail.jpg)
    meta = j['extensions']['VRMC_vrm']['meta']
    thumb = ROOT / 'scripts' / 'assets' / 'claire-thumbnail.jpg'
    if thumb.exists():
        index = meta['thumbnailImage']
        glb.replaced[j['images'][index]['bufferView']] = thumb.read_bytes()
        j['images'][index]['mimeType'] = 'image/jpeg'
    meta['name'] = 'Claire'
    meta['authors'] = ['pixiv Inc.', 'Avatar3D (adaptation : Claire)']
    meta['version'] = 'claire-1.0'

    glb.save(OUT)
    print(f'{OUT.relative_to(ROOT)} : {OUT.stat().st_size / 1e6:.1f} Mo')


if __name__ == '__main__':
    main()
